# suverse-pay

> Unified payment gateway for the [x402](https://github.com/x402-foundation/x402)
> protocol — a Stripe-like REST API that abstracts multiple x402
> facilitator providers (Coinbase CDP, our own
> [cosmos-pay](https://github.com/sudzikcoin/cosmos-pay), future
> PayAI/Questflow/thirdweb/etc.) behind a single API.

**Status:** Phase 1 — scaffolding. Not yet usable end-to-end. See
`TASK.md` for the implementation brief and `CLAUDE.md` for architectural
conventions.

## What it does

A developer writes one integration against `suverse-pay`. Under the
hood the gateway picks the optimal facilitator and chain for each
payment based on cost, latency, success rate, and merchant policy. The
developer never thinks about which chain, which provider, or which
scheme is being used. If the chosen provider fails on a retryable
error, the gateway falls back to another provider that supports the
same route.

## Architecture

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

## Requirements

- Node.js ≥ 20
- pnpm ≥ 10 (the repo pins `packageManager`)
- Postgres 15 + Redis 7 — via `docker compose up -d` or your own
  installation

## Local dev setup

```bash
# Install workspace dependencies
pnpm install

# Configure environment
cp .env.example .env
# edit .env — set ADMIN_API_KEY (long random string), COSMOS_PAY_BASE_URL,
#                COINBASE_CDP_API_KEY_NAME/SECRET if you have them.

# Start Postgres + Redis (skip if you already run them). The default
# host ports are 5433 / 6380 so we don't fight a host-level Postgres
# already on 5432.
docker compose up -d

# Apply the schema (idempotent — safe to re-run).
pnpm db:migrate

# Seed the admin api_key row from your ADMIN_API_KEY env. Required
# before the API server will accept any request. Idempotent: a
# second run with the same key is a no-op. To ROTATE the key after
# changing ADMIN_API_KEY in your env, re-run with `--force`.
pnpm db:bootstrap
# To rotate: ADMIN_API_KEY=<new-key> pnpm db:bootstrap --force

# Build + test everything
pnpm build
pnpm test
```

### About the admin api_key

v0.1 ships single-tenant. Bootstrap inserts one row in `api_keys`
with `id='apikey_admin_default'` and
`key_hash = sha256(ADMIN_API_KEY)`. The API server holds the same
hash in memory at boot and compares every incoming
`Authorization: Bearer <key>` against it. The plaintext key never
touches the DB, the logs, or any error message. Phase 4 will keep
the same row shape and add tenant-minted rows alongside it.

## Layout

```
apps/api/                  REST API server (Fastify)
services/orchestrator/     Routing, registry, fallback, ledger
packages/core-types/       Shared types + Zod schemas
packages/provider-sdk/     Adapter base class
packages/adapters/         Per-provider adapters (cosmos-pay, coinbase-cdp)
db/                        Migrations + bootstrap scripts
scripts/smoke/             Smoke tests (mocked + real)
```

## Repo conventions

- License: Apache-2.0.
- Commits: [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `chore:`, etc.).
- Branch protection: enforce on `main` once the team grows beyond one.

## License

[Apache-2.0](./LICENSE)
