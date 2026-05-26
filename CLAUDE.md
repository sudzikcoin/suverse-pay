# CLAUDE.md — suverse-pay project context

This file is loaded automatically by Claude Code on every session. Read
fully on first load. Consult `TASK.md` for the current job.

## What this repo is

**suverse-pay** is a unified payment gateway for the x402 protocol.
A single REST API that abstracts away the differences between multiple
x402 facilitator providers (Coinbase CDP, our own cosmos-pay, PayAI,
etc.), with smart routing, fallback, normalized responses, and
per-merchant policy. An MCP server is a Phase 2 deliverable; do not
build it in Phase 1.

Positioning: **"Stripe-like API for all x402 facilitators."**

A developer writes one integration against `suverse-pay`. Under the
hood we pick the optimal facilitator/chain for each payment based on
cost, latency, success rate, and merchant policy. The developer never
thinks about which chain, which provider, or which scheme is being used.

## Where this sits in the ecosystem

```
┌────────────────────────────────────────────────────┐
│  AI agents, dev tools, applications                │
└─────────────────────┬──────────────────────────────┘
                      │ REST (Phase 1) / MCP (Phase 2)
                      ▼
┌────────────────────────────────────────────────────┐
│  suverse-pay (this repo)                           │
│   - normalizes facilitator APIs                    │
│   - routes by cost/latency/success rate            │
│   - handles fallback and retry                     │
│   - records every payment attempt                  │
└────┬─────────────┬──────────────┬──────────────────┘
     │             │              │
     ▼             ▼              ▼
┌──────────┐ ┌──────────┐  ┌──────────────┐
│ Coinbase │ │ cosmos-  │  │ Future:      │
│   CDP    │ │   pay    │  │ PayAI,       │
│ (EVM +   │ │ (Cosmos  │  │ Questflow,   │
│  Solana) │ │  SDK     │  │ xpay,        │
│          │ │  chains) │  │ thirdweb     │
└──────────┘ └──────────┘  └──────────────┘
```

## Relation to `sudzikcoin/cosmos-pay`

The sister repo `sudzikcoin/cosmos-pay` is the standalone Cosmos x402
facilitator. It runs as its own service with its own HTTP API
(`/verify`, `/settle`, `/supported`).

From `suverse-pay`'s perspective, `cosmos-pay` is **one provider
adapter among several**. We wrap its HTTP API in
`packages/adapters/cosmos-pay/` and treat it like any other facilitator.

Do NOT vendor or copy code from `cosmos-pay` into this repo. Reference
it via HTTP. The two repos are independent; `cosmos-pay` is Go, this
one is TypeScript.

## Tech stack

Locked decisions — do not relitigate without explicit user approval:

- **Language**: TypeScript (Node.js 20+)
- **HTTP framework**: Fastify
- **Database**: PostgreSQL 15+
- **Cache / rate limiting / idempotency**: Redis 7+
- **Background jobs**: BullMQ (Redis-backed)
- **Observability**: pino structured logging + OpenTelemetry traces
- **Schema validation**: Zod
- **Testing**: vitest + supertest for API integration tests
- **Monorepo tooling**: pnpm workspaces + Turborepo

## Architectural law: four layers

This is the binding architecture. Do not collapse layers or skip them.

1. **Interface layer** — `apps/api` only in Phase 1. `apps/mcp` and
   `apps/admin` are reserved for Phase 2+ and MUST NOT be scaffolded
   in Phase 1, even as empty packages. External entry points: auth,
   rate limiting, request validation, idempotency. No business logic;
   delegates to orchestration.

2. **Orchestration layer** — `services/orchestrator`. The brain.
   Provider registry, routing engine, policy engine, quote engine,
   fallback manager, fee engine. **This is the moat. Do not bypass.**

3. **Provider adapter layer** — `packages/adapters/*`. Each adapter
   wraps one external facilitator behind a normalized interface.
   Adapters MUST be pure HTTP/SDK clients with no business logic.

4. **Native facilitator layer** — explicitly out of scope for v0.1.
   When we add native settlement later, it goes in
   `services/native-facilitator` as a separate isolated service with
   its own security boundary, exposed to the orchestrator as just
   another adapter.

## Provider adapter contract

Every adapter implements this exact interface (defined in
`packages/core-types`):

```typescript
interface ProviderAdapter {
  readonly id: string;                  // "coinbase-cdp", "cosmos-pay"
  readonly displayName: string;

  supports(req: SupportQuery): Promise<SupportResult>;
  quote(req: QuoteRequest): Promise<QuoteResponse>;
  verify(req: VerifyRequest): Promise<VerifyResponse>;
  settle(req: SettleRequest): Promise<SettleResponse>;
  getStatus(paymentId: string): Promise<StatusResponse>;
  healthCheck(): Promise<HealthStatus>;

  // Optional. Implement if and only if the provider exposes a way to
  // enumerate supported networks/assets/schemes dynamically (e.g. a
  // `/supported` endpoint). Called by a separate slow cron, NOT by
  // healthCheck(). If the provider has no such surface, omit this
  // method — adapter capabilities then come from static config only.
  discoverCapabilities?(): Promise<DiscoveredCapability[]>;
}
```

### Synthetic vs native operations

Not every provider exposes every operation natively. Specifically,
`quote()` is a normalized gateway concept; some facilitators (Coinbase
CDP among them) have no public "quote endpoint" — they expose only
`/verify` and `/settle`.

In such cases, the adapter's `quote()` is **synthetic**: it computes
the response from the provider's `supports()` result plus configured
fee metadata in `providers.config` plus recent health statistics from
`provider_health_checks`.

This is by design and explicitly allowed. The adapter MUST still
return a well-formed `QuoteResponse`. The `source` field in
`QuoteResponse` is typed as `'native' | 'synthetic'` so the
orchestrator can weight them appropriately.

### Capabilities: static + runtime-discovered

Each provider's capability set (supported networks, assets, schemes)
comes from two sources:

1. **Static** — declared in `providers.config` at adapter registration
   time. Boot-time floor: what we know works.
2. **Runtime-discovered** — fetched via the adapter's optional
   `discoverCapabilities()` method, run by a separate slow cron
   (every 1-6 hours), cached in `provider_capabilities` table with
   `is_discovered = true` and `discovered_at` set.

**Critical distinction**: capability discovery is NOT part of
`healthCheck()`. Health checks run frequently (every 30-60 seconds)
and must be cheap. Capability discovery runs rarely (hours) and is
allowed to be slow. Conflating them makes either the health path
fragile or the capability data stale.

`GET /providers` returns the **union** of static and discovered
capabilities. A single capability row may be both
`is_static = true` AND `is_discovered = true`. If discovery reveals a
capability that contradicts static config (e.g. provider no longer
supports Network X), mark the static row's `superseded_at` and treat
the discovered fact as authoritative going forward, with a warning
in logs.

This isolates the gateway from provider roadmap changes — when
Coinbase adds a new chain to CDP, our gateway picks it up on the next
discovery cycle without a code change.

## Critical invariants — do not break

1. **Idempotency.** Every `/settle` call MUST be idempotent on the
   `Idempotency-Key` header. Duplicate calls with the same key MUST
   return the same response without re-broadcasting.

   Two-layer implementation, both layers required:

   - **Canonical source of truth: Postgres.** The unique index on
     `(api_key_id, idempotency_key)` in `payments` table enforces
     uniqueness at the database level. This is the authoritative
     guarantee — even if Redis is wiped, duplicates cannot be
     committed.

   - **Concurrency control: Redis.** A short-lived `SETNX` lock on
     `idem:{api_key_id}:{idempotency_key}` with a 30-second TTL
     prevents two concurrent requests from racing to create the
     payment row. The lock is released after the payment is
     committed (or aborted). The lock is NOT relied on for
     correctness — it only prevents wasted work and duplicate
     provider calls during the race window.

   On a duplicate `/settle` request:
   1. Try to acquire the Redis lock. If it's held, wait briefly
      (up to 5s) and re-check.
   2. Try to insert into `payments`. If unique-index conflict, fetch
      the existing row and return its response.
   3. If insert succeeds, hold the lock until settlement completes,
      then release.

   The Postgres unique index is the final arbiter. Redis is fast-path
   optimization only.

2. **No business logic in adapters.** Adapters translate. They do not
   decide. If you find yourself writing `if (provider === 'coinbase')`
   anywhere outside the adapter folder — stop.

3. **Provider abstraction.** Internal code MUST NOT depend on a
   specific provider's response shape. Always normalize to the
   contract types in `packages/core-types`.

4. **Observability before optimization.** Every payment attempt logs
   `payment_attempts` row BEFORE the network call. If we crash
   mid-call, we want the record to exist.

5. **Security boundary for future native facilitator.** When we
   eventually add `services/native-facilitator`, it runs as a separate
   process with its own credentials. The API gateway never directly
   touches signing keys.

6. **No vendored secrets.** Mnemonics, API keys, signing keys — env
   vars only. `.env` in `.gitignore`. CI checks for accidental
   commits.

## What is OUT of scope for v0.1

Do not build these without explicit instruction:

- The MCP server (`apps/mcp`). Phase 2 deliverable.
- Admin UI (`apps/admin`). Phase 2+ deliverable.
- Native facilitator settlement logic — we use external facilitators
  only in v0.1.
- AI-based routing. v0.1 is rule-based.
- Multi-tenancy with billing. v0.1 has a single bootstrapped admin
  api_key row, but the schema is already multi-tenant-ready.
- Webhooks.
- Fiat ramp integration.
- Dashboard UI.
- Per-bps fees on payments.
- More than two adapters. v0.1 ships with cosmos-pay + Coinbase CDP
  only.

## Common gotchas

1. **Idempotency keys vs payment IDs.** Idempotency-Key is supplied
   by the client. Payment ID is generated by us. Don't conflate them.

2. **Provider health flapping.** A provider returning one 503 doesn't
   mean it's down. Use a sliding window with minimum sample size
   (>=10 attempts) before marking unhealthy. See routing logic in
   TASK.md for the exact rule.

3. **CAIP-2 chain identifiers.** x402 V2 uses CAIP-2 (`eip155:8453`
   for Base, `cosmos:noble-1` for Noble, etc.). Internal types use
   CAIP-2 everywhere. Adapters translate to/from provider-specific
   formats.

4. **Quote vs verify vs settle semantics.** Different facilitators
   merge these differently. Normalize against the x402 V2 spec:
   - quote: "how much, on what chain, what scheme?" (may be synthetic)
   - verify: "is this signature valid?" (cheap, no broadcast)
   - settle: "broadcast it" (expensive, on-chain)

5. **Coinbase CDP authentication.** The exact auth scheme (Bearer
   token, signed JWT, HMAC, key+secret pair, etc.) is determined by
   what CDP currently requires for x402 facilitator API. Read the
   CDP docs at implementation time and conform. The adapter
   encapsulates this; the gateway code MUST NOT assume any particular
   scheme. Env var names for CDP credentials are adapter-internal
   (`COINBASE_CDP_*`).

6. **Coinbase CDP rate limits.** Free tier is 1000 settled
   payments/month per API key. After that $0.001 each. Adapter must
   track usage in Redis and respect `COINBASE_CDP_MONTHLY_HARD_CAP`
   (default 5000) to prevent runaway costs.

## When you finish a phase

Before declaring a phase done:

1. `pnpm build` clean across all packages.
2. `pnpm test` green (unit + integration).
3. Manual smoke tests per acceptance criteria in `TASK.md`.
4. README updated.
5. CHANGELOG entry (exact version naming flexible).

If any of those fail, you are not done.
