# suverse-pay

Unified payment gateway for HTTP-native payments. A single REST API
that abstracts multiple facilitator providers across multiple payment
protocols, with smart routing, fallback, and idempotent settlement.

**Positioning:** Stripe-like API for the agentic payments ecosystem.
A developer writes one integration against `suverse-pay`; the gateway
picks the optimal chain and provider per payment based on cost,
latency, success rate, and merchant policy. If the chosen provider
returns a retryable error, the gateway falls back to another provider
that supports the same `(network, asset, scheme)` triple.

## Status

**v0.4.0 — "Multi-protocol multi-chain"** (2026-05-29). Phase 4
closed. Three payment protocols, eleven blockchain namespaces, seven
facilitator adapters.

- Build: green across **19 packages**
- Tests: green across the workspace test suite — **36 turbo tasks**

### Supported protocols

| Protocol | Wire | Adapters |
| --- | --- | --- |
| **x402** (Coinbase) | HTTP 402 + `X-PAYMENT` body | cosmos-pay, coinbase-cdp, payai, thirdweb-x402, binance-x402, bofai-x402 |
| **MPP** (Stripe + Tempo) | HTTP 402 + `WWW-Authenticate: Payment` headers | mpp |
| **t402** (universal USDT) | x402 with `t402Version` field rename | t402-io |

### Network coverage (11 namespaces)

| Namespace | Networks (signer-backed end-to-end) | Capability-advertised only |
| --- | --- | --- |
| `eip155:` (EVM) | 17 mainnets — Base, Polygon, Arbitrum, World Chain, Avalanche, Ethereum, Optimism, BNB Chain, XDC, Monad, Sonic, Sei, Abstract, IoTeX, Celo, Ink, Linea, Tempo + 5 testnets | — |
| `tron:` | mainnet, Nile testnet (via BofAI; native signer-tron in Phase 5) | — |
| `solana:` | mainnet, devnet (signer-solana) | — |
| `cosmos:` | **noble-1 mainnet** (via t402-io), grand-1 testnet (cosmos-pay) | — |
| `aptos:` | — | mainnet + testnet (via t402-io) |
| `near:` | — | mainnet + testnet (via t402-io) |
| `polkadot:` | — | 2 parachains (via t402-io) |
| `stacks:` | — | mainnet + testnet (via t402-io) |
| `stellar:` | — | pubnet + testnet (via t402-io) |
| `tezos:` | — | mainnet + testnet (via t402-io) |
| `ton:` | — | mainnet + testnet (via t402-io) |

### Maturity disclosure

Battle-tested on real-network smoke:

- **coinbase-cdp** — real EVM USDC settle on Base Sepolia (v0.3.1)
- **cosmos-pay** — real Cosmos `MsgExec(MsgSend)` on Noble grand-1 (v0.2.0)
- **payai** — real Solana devnet SPL `transferChecked` (v0.3.0)

Wired against documented spec; real on-chain smoke deferred to Phase 5:

- **thirdweb-x402** — 11 EVM mainnets routed; needs Thirdweb Nexus
  API key for live `/verify`+`/settle` smoke
- **binance-x402** — BNB Chain wiring against documented Binance Pay
  HMAC-SHA512 + canonical x402 v2; needs Binance Pay merchant
  onboarding
- **bofai-x402** — TRON + BSC; open access on `/supported` + `/health`;
  forwarder-only until native `signer-tron` lands
- **mpp** — Tempo USDC + Stripe SPT capabilities advertised; HTTP
  `/mpp/*` routes land in Phase 5 Phase 2 T8 for Tempo Moderato
  testnet via direct JSON-RPC. Mainnet stays deferred until Stripe
  publishes the REST surface.
- **t402-io** — Capability advertising live (77 `(network, scheme)`
  tuples); `/verify`+`/settle` gated on `X-API-Key` with no public
  signup flow as of 2026-05-29. `/health` reports `version: "dev"` —
  not production-versioned

Capability-only (Phase 5 native signers required to settle):

- TON, NEAR, Aptos, Tezos, Polkadot, Stacks, Stellar — all routable
  via t402-io once corresponding signers ship

### Customer dashboard (new in v0.5.0-alpha)

Live at `https://suverse-pay.suverse.io` (DNS + OAuth setup needed
before first sign-in works — see
[`apps/dashboard/README.md`](apps/dashboard/README.md) for the
operator runbook).

- OAuth sign-in via Google or GitHub (NextAuth.js v5, JWT sessions)
- Multi-tenant: one OAuth user can link N existing resource API keys
- Four panels: summary cards, volume chart, recent settles, network
  breakdown — all scoped to the user's linked keys, 30-second
  auto-refresh
- Dark-mode-default editorial dashboard aesthetic (JetBrains Mono
  for figures, Inter Tight body, single amber accent)
- Self-serve API key signup deferred to the next Phase 5 sub-task

### Smoke suites (still green from Phase 3)

- `mocked` (10) — full gateway end-to-end against mock adapters
- `real` (9) — admin REST surface against real cosmos-pay
- `mcp-mocked` (7) — MCP against a mock x402 + mock gateway
- `mcp-real` (4) — real `MsgExec(MsgSend)` on Noble grand-1
- `facilitator-mocked` (10) — public `/facilitator/*` surface
- `mcp-solana` (5) — real Solana devnet `transferChecked` via PayAI
- `real-evm` (7) — real Base Sepolia via Coinbase CDP

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
the smoke mocks, set the adapter env vars and start the API:

```bash
# x402 facilitators (all optional — adapters fall back to capability-
# only mode if their keys are missing)
export COINBASE_CDP_API_KEY_NAME=... COINBASE_CDP_API_KEY_SECRET=...
export THIRDWEB_X402_API_KEY=...      # Thirdweb Nexus
export BINANCE_X402_API_KEY=... BINANCE_X402_API_SECRET=...  # BNB Chain
export PAYAI_API_KEY_ID=... PAYAI_API_KEY_SECRET=...  # paid tier (optional)
# BofAI is open access — no key required for facilitator.bankofai.io

# Multi-protocol
export STRIPE_MPP_SECRET_KEY=sk_test_... # MPP via Stripe + Tempo
export T402_IO_API_KEY=...               # t402-io universal USDT

pnpm --filter @suverse-pay/api run dev
```

Each adapter logs a status line at boot showing whether credentials are
present. Adapters without credentials still register (capability
advertising + health checks work) but their `/verify` and `/settle`
return `unauthorized` until configured.

### Observability (Grafana + Prometheus)

Opt-in operator dashboard. Both services live behind the
`observability` Docker Compose profile so a normal dev loop doesn't
pull two extra images.

```bash
docker compose --profile observability up -d grafana prometheus
open http://localhost:3030        # admin / admin (override via env)
```

Pre-provisioned dashboard: "Facilitator Observability" — settle
activity by adapter / network, failover events, top resource keys,
adapter health, rate-limit hits. Full reference and panel breakdown
in [`docs/observability.md`](docs/observability.md).

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
  smoke on Noble testnet. **(v0.2.0)**
- **Phase 3** — Solana signer + adapter, PayAI adapter as a third
  facilitator, public x402 facilitator surface at `/facilitator/*`,
  real Solana devnet smoke. **(v0.3.0 / v0.3.1)**
- **Phase 4** — Multi-protocol multi-chain. Five new adapters
  (Thirdweb, Binance, BofAI, Stripe MPP, t402-io), 11 namespaces,
  17 EVM mainnets + TRON + Cosmos mainnet, Permit2 signing for USDT,
  internal Grafana stack. **(this release, v0.4.0)**
- **Phase 5+** — Native non-EVM signers (TON, NEAR, Aptos, Tezos,
  Polkadot, Stacks, Stellar; EIP-2612 Permit for EVM). Real-network
  mainnet smoke per adapter. MPP HTTP `/mpp/*` surface once Stripe
  publishes REST paths. Multi-tenant customer dashboard + self-serve
  resource key signup. Native facilitator settlement (isolated
  service with its own credentials).

## License

[Apache-2.0](./LICENSE)
