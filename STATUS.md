# STATUS

Last session: 2026-05-28
Last tag: v0.3.0

## Current state
**Phase 3 complete. v0.3.0 released.** Solana support across signer,
PayAI adapter, MCP, and a public x402 facilitator surface — all
proven end-to-end on real testnet:

- **Solana devnet end-to-end via MCP → PayAI.** Real
  `transferChecked` broadcast on Solana devnet, no Coinbase CDP API
  key required. Idempotent replay returns the cached `txSignature`
  without re-submitting on-chain.
- **Public x402 facilitator endpoints** at `/facilitator/{supported,
  verify,settle}` route across cosmos-pay, Coinbase CDP, and PayAI
  with per-route failover. Resource servers can adopt suverse-pay
  as their facilitator URL and get multi-chain routing for free.
- **PayAI adapter** wraps `https://facilitator.payai.network`
  (Solana mainnet + devnet) as a third provider behind the
  orchestrator and the public facilitator surface.
- All 6 smoke suites pass:
  - `mocked` (10 steps)
  - `real` (9 steps)
  - `mcp-mocked` (7 steps)
  - `mcp-real` (4 steps — real Cosmos broadcast on Noble grand-1)
  - `facilitator-mocked` (10 steps — gateway as facilitator)
  - `mcp-solana` (5 steps — real Solana devnet broadcast via PayAI)

## Infrastructure
- Postgres on :5433, Redis on :6380 (Docker)
- To restart: `cd /home/govhub/suverse-pay && docker compose up -d && pnpm db:migrate && pnpm db:bootstrap`

## Running services
- cosmos-pay facilitator at :8402 (Go, separate repo)
- suverse-pay API at :3000 (this repo, `apps/api`) — serves both the
  admin REST surface AND the public `/facilitator/*` x402 routes
- MCP server at :3100 (this repo, `apps/mcp`) — spawned on-demand by
  the mcp-* smoke suites

The cosmos-pay and suverse-pay processes survive across sessions;
restart per their respective READMEs if dead. Setting
`SUVERSE_PAY_ADMIN_KEY` (= `ADMIN_API_KEY`) is required to boot the
MCP server.

## Phase 4 markers (when ready, do not start without explicit decision)
- Multi-tenancy + billing: per-resource API keys with quota, monthly
  invoicing, Stripe Connect or similar
- Webhooks for terminal payment states
- Coinbase CDP real-network smoke (still gated on CDP API key)
- PayAI mainnet smoke (gated on a small mainnet USDC allowance — see
  IDEAS.md entry 8)
- Signup automation for the public facilitator surface (resource API
  key issuance + dashboard — see IDEAS.md entries 9, 10)
- AI-assisted routing once we have enough payment_attempts data to
  train on

## How to resume work next session
1. `cd /home/govhub/suverse-pay`
2. `claude`
3. First prompt: "Read STATUS.md and CLAUDE.md, summarize current
   state, ask what to work on next"

## Out of scope (do not pursue without explicit decision from user)
- Outreach to x402 Foundation / Coinbase / Posthuman / PayAI
- Production deploy
- Native facilitator settlement (Phase 5+)
