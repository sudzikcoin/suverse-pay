# suverse-pay

Unified payment gateway for the [x402](https://github.com/x402-foundation/x402)
protocol. A single REST API that abstracts multiple x402 facilitator
providers (Coinbase CDP, our own [cosmos-pay](https://github.com/sudzikcoin/cosmos-pay),
future PayAI / Questflow / thirdweb / etc.) behind smart routing,
fallback, and idempotent settlement.

**Positioning:** Stripe-like API for all x402 facilitators. A developer
writes one integration against `suverse-pay`; the gateway picks the
optimal chain and provider per payment based on cost, latency, success
rate, and merchant policy. If the chosen provider returns a retryable
error, the gateway falls back to another provider that supports the
same `(network, asset, scheme)` triple.

## Status

**v0.2.0** — Phase 2 complete. MCP server with multi-network signing,
Bazaar discovery, and verified real on-chain payment via the MCP
flow on Noble testnet `grand-1`.

- Build: green across 11 packages
- Tests: green across 20 workspace test tasks (~400 tests total —
  signers, discovery aggregator, MCP integration, gateway routes,
  orchestrator, adapters)
- Smoke: 4 suites green — `mocked` (10 steps), `real` (9 steps),
  `mcp-mocked` (7 steps), `mcp-real` (4 steps)
- MCP: real `MsgExec(MsgSend)` broadcast on Noble grand-1, idempotent
  replay returns the same `txHash` without re-broadcasting

## Quick start

```bash
git clone https://github.com/sudzikcoin/suverse-pay && cd suverse-pay
pnpm install

# Postgres 15 + Redis 7 on host ports 5433 / 6380 (chosen to avoid a
# host-level Postgres / Redis on the usual 5432 / 6379).
docker compose up -d

# Pick any long random string. The gateway hashes it (sha256) and
# stores the digest; the plaintext never lands on disk.
export ADMIN_API_KEY="$(openssl rand -hex 32)"
export DATABASE_URL="postgres://suverse:suverse@localhost:5433/suverse_pay"
export REDIS_URL="redis://localhost:6380"

pnpm db:migrate       # create the schema (idempotent)
pnpm db:bootstrap     # seed the apikey_admin_default row

# Drive the gateway end-to-end against in-memory mock adapters. No
# external HTTP, no CDP credentials needed — 10/10 should PASS.
bash scripts/smoke/mocked/run-all.sh
```

To run the production server with real provider adapters instead of
the smoke mocks: set `COINBASE_CDP_API_KEY_NAME` / `*_SECRET` (see
`.env.example`) and `pnpm --filter @suverse-pay/api run dev`.

## Architecture

```
┌────────────────────────────────────────────────────┐
│  AI agents                                         │
└─────────────────────┬──────────────────────────────┘
                      │ MCP streamable HTTP
                      ▼
┌────────────────────────────────────────────────────┐
│  apps/mcp            init_session, pay_and_call,   │
│                      discover_endpoints, ...       │
│   ├─ signers (cosmos / evm) — in-memory only       │
│   ├─ discovery aggregator (Bazaar + catalogs)      │
│   └─ idempotency cache (payerAddress + hourBucket) │
└─────────────────────┬──────────────────────────────┘
                      │ REST + Bearer auth
                      ▼
┌────────────────────────────────────────────────────┐
│  apps/api            Fastify HTTP, auth, idempotency
├────────────────────────────────────────────────────┤
│  services/orchestrator                             │
│    routing • fallback • ledger • capability cron   │
│    health-check cron • policy resolution           │
├────────────────────────────────────────────────────┤
│  packages/adapters/* (one per provider)            │
└────┬─────────────┬──────────────┬──────────────────┘
     │             │              │
     ▼             ▼              ▼
┌──────────┐ ┌──────────┐  ┌──────────────┐
│ Coinbase │ │ cosmos-  │  │ Future:      │
│   CDP    │ │   pay    │  │ PayAI,       │
│ (EVM +   │ │ (Cosmos  │  │ Solana, ...  │
│  Solana) │ │  chains) │  │              │
└──────────┘ └──────────┘  └──────────────┘
```

The MCP server is the agent-facing entry point added in v0.2.0. See
[`apps/mcp/README.md`](./apps/mcp/README.md) for tool reference,
configuration, and the agent-side x402 flow.

Four binding layers (see `CLAUDE.md` for the full rationale):

1. **Interface** — `apps/api` only. Auth, validation, idempotency
   extraction. Zero business logic.
2. **Orchestration** — `services/orchestrator`. The brain: provider
   registry, routing engine, fallback manager, payment ledger,
   capability + health crons. Pure logic is split from IO so most of
   it is testable without a database.
3. **Provider adapters** — `packages/adapters/*`. HTTP/SDK clients
   that translate a provider's wire format to the normalized adapter
   contract. No decisions, no business logic.
4. **Native facilitator** — out of scope for v0.1. When it lands it
   will live in its own isolated service with its own credentials.

## API

Seven endpoints, all under `Authorization: Bearer <ADMIN_API_KEY>`
except `/health`. The Phase 1 wire format is documented in detail in
[`TASK.md`](./TASK.md) §"REST API specification".

| Method | Path                     | Purpose                                                    |
|--------|--------------------------|------------------------------------------------------------|
| GET    | `/health`                | Liveness (no auth). Does NOT verify providers.             |
| GET    | `/providers`             | Configured providers, capabilities, latest health summary. |
| POST   | `/quote`                 | Cost/latency/success-rate quotes for a payment.            |
| POST   | `/verify`                | Verify a payment payload via the routed provider.          |
| POST   | `/settle`                | Settle on-chain, with fallback. Requires `Idempotency-Key`. |
| GET    | `/payments/:id`          | Look up a payment + its attempt list.                      |
| GET    | `/metrics/summary`       | Aggregate stats: totals + per-provider rolls.              |

## Repo layout

```
apps/api/                  Fastify HTTP entrypoint + plugins + routes
services/orchestrator/     Routing, registry, fallback, ledger, crons
packages/core-types/       Shared types + Zod schemas
packages/provider-sdk/     BaseAdapter + httpJson with retry+timeout
packages/adapters/         Concrete provider adapters
  ├── cosmos-pay/          Sister Go facilitator wrapped over HTTP
  └── coinbase-cdp/        CDP x402 facilitator + EdDSA JWT auth
db/                        SQL migrations + bootstrap CLI
scripts/smoke/mocked/      curl-based mocked end-to-end suite
.github/workflows/ci.yml   unit + integration jobs (PG/Redis services)
docker-compose.yml         Postgres 15 + Redis 7, ports 5433 / 6380
```

## Development

### Running tests

```bash
# Unit suite — fast, no Postgres required.
pnpm test
# 284 tests across 7 packages

# Integration suite — requires `docker compose up -d` + migrations +
# bootstrap. 25 end-to-end tests with nock-intercepted HTTP.
pnpm test:integration

# Mocked smoke suite — same coverage as integration but driven by
# shell + curl, useful when eyeballing behaviour.
bash scripts/smoke/mocked/run-all.sh
```

`pnpm test` is intentionally Postgres-free so it stays green on every
developer laptop. The Docker-backed integration suite has its own
script + CI job.

### Adding a provider adapter

1. Create `packages/adapters/<name>/` mirroring the layout of
   `packages/adapters/cosmos-pay/`.
2. Extend `BaseAdapter` from `@suverse-pay/provider-sdk` and implement
   the `ProviderAdapter` interface from `@suverse-pay/core-types`.
3. Register it in `apps/api/src/index.ts` alongside the existing
   adapters; add the static capability list to `providers.config` so
   the routing engine knows it exists at boot.
4. Add unit tests against mocked HTTP; the integration suite picks up
   newly registered adapters automatically once the test setup
   includes them.

See `TASK.md` §"Provider adapter contract" and CLAUDE.md
§"Architectural law: four layers" for the binding rules.

## Known limitations (v0.1)

- **Race-replay can return a `pending` payment.** Two concurrent
  `/settle` calls with the same `Idempotency-Key` produce exactly one
  payment row and exactly one outbound provider call (verified
  end-to-end), but the *replay* request can observe the row while the
  primary is still finalizing it. Clients should `GET /payments/:id`
  to see the terminal state. Phase 2 will tighten this by holding the
  Redis lock through finalization.
- **Single-tenant.** Bootstrap seeds one `api_keys` row. The schema
  is already multi-tenant-ready; Phase 4 fills it.
- **Rotation requires a restart.** `pnpm db:bootstrap --force` updates
  the on-disk hash; the running API server keeps the previous hash
  in memory until restarted. Documented behaviour.
- **One flaky test** in `services/orchestrator/src/health-check.test.ts:177`
  (timing-dependent `setInterval` tick test) is `it.skip`ped with a
  TODO to rewrite using fake timers in Phase 2.
- **Real-network smoke deferred.** v0.1.0-rc.1 covers mocked
  acceptance only. Real cosmos-pay (Cosmos testnet) + Coinbase CDP
  smoke runs are the gate to the `v0.1.0` tag.

## Roadmap

- **Phase 1** — REST gateway, two adapters, smart routing,
  idempotency, mocked + real-network smoke. **(v0.1.0)**
- **Phase 2** — MCP server (`apps/mcp`), Cosmos + EVM signers,
  discovery aggregator (Bazaar + cosmos catalog), real on-chain MCP
  smoke on Noble testnet. **(this release, v0.2.0)**
- **Phase 3** — Solana signer + adapter, Coinbase CDP real smoke
  (requires API key), additional discovery sources (PayAI,
  Solana Foundation gateway).
- **Phase 4** — Multi-tenancy + billing, webhooks.
- **Phase 5+** — Native facilitator settlement (isolated service
  with its own credentials), AI-assisted routing.

## License

[Apache-2.0](./LICENSE)
