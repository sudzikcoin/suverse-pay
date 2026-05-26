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
# edit .env — set ADMIN_API_KEY, COSMOS_PAY_BASE_URL, etc.

# Start Postgres + Redis (skip if you already run them)
docker compose up -d

# Build + test everything
pnpm build
pnpm test
```

The bootstrap script for the admin api_key and the API server itself
are introduced in later Phase 1 steps — see `TASK.md` §Implementation
order.

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
