# STATUS

Last session: 2026-05-28
Last tag: v0.3.1

## Current state
**Phase 3 closed including Sub-task 4. v0.3.1 released.** The last
remaining v0.3.0 deferred item — Coinbase CDP real-network smoke —
is closed with two real Base Sepolia transactions broadcast via CDP
through both the internal `/settle` and public `/facilitator/settle`
paths:

- internal `/settle`:        https://sepolia.basescan.org/tx/0x618913f76b23878b2d0db3cba83c9073f45371ff790e972c240f5771bc74abfd
- public `/facilitator/settle`: https://sepolia.basescan.org/tx/0xac4ca10622443a1c1b1d201d1e7993d86f8e263493a9a5a301fbb60f59139e21

Idempotency proven under real CDP conditions: a replay of `/settle`
with the same `Idempotency-Key` + same signed payload returns the
same `paymentId` + same `txHash` with exactly one row in
`payment_attempts`.

### Everything carried over from v0.3.0

- **Solana devnet end-to-end via MCP → PayAI.** Real
  `transferChecked` broadcast on Solana devnet, no CDP API key
  required. Idempotent replay returns the cached `txSignature`
  without re-submitting on-chain.
- **Public x402 facilitator endpoints** at `/facilitator/{supported,
  verify,settle}` route across cosmos-pay, Coinbase CDP, and PayAI
  with per-route failover. Multi-chain facilitator surface is now
  real-tested on Cosmos (Noble grand-1), Solana devnet (PayAI), AND
  EVM (Base Sepolia via CDP).
- **PayAI adapter** wraps `https://facilitator.payai.network`
  (Solana mainnet + devnet) as a third provider.
- All 7 smoke suites pass:
  - `mocked` (10 steps)
  - `real` (9 steps — Cosmos grand-1)
  - `mcp-mocked` (7 steps)
  - `mcp-real` (4 steps — real Cosmos broadcast on Noble grand-1)
  - `facilitator-mocked` (10 steps)
  - `mcp-solana` (5 steps — real Solana devnet via PayAI)
  - **`real-evm` (7 steps — real Base Sepolia via Coinbase CDP) — NEW in v0.3.1**

## Infrastructure
- Postgres on :5433, Redis on :6380 (Docker)
- To restart: `cd /home/govhub/suverse-pay && docker compose up -d && pnpm db:migrate && pnpm db:bootstrap`

## Running services
- cosmos-pay facilitator at :8402 (Go, separate repo)
- suverse-pay API at :3000 (this repo, `apps/api`) — serves both the
  admin REST surface AND the public `/facilitator/*` x402 routes.
  Must be started with `.env` sourced into the process so the CDP
  env vars (`COINBASE_CDP_API_KEY_NAME` / `_SECRET`) are read at
  boot — otherwise the gateway skips CDP registration and the
  `real-evm` smoke fails at 00-setup with a clear message.
- MCP server at :3100 (this repo, `apps/mcp`) — spawned on-demand by
  the mcp-* smoke suites

The cosmos-pay and suverse-pay processes survive across sessions;
restart per their respective READMEs if dead. Setting
`SUVERSE_PAY_ADMIN_KEY` (= `ADMIN_API_KEY`) is required to boot the
MCP server.

## EVM test wallet (for real-evm smoke)
The smoke suite uses a dedicated Base Sepolia test wallet whose
mnemonic lives at `.env.evm-sepolia` (mode 600, gitignored). At time
of release the address is
`0xA2F8a871AfDC463aaEf5FAe8284d900f4d02538E`. Refill via the
Coinbase CDP faucet when:
- USDC balance < `SMOKE_REVM_AMOUNT_ATOMIC × 3` atomic (default
  3000 atomic = 0.003 USDC) — 00-setup will refuse to run otherwise.
- ETH-Sepolia is depleted (rare — each settle uses a few drops).

## Phase 4 markers (when ready, do not start without explicit decision)
- Multi-tenancy + billing: per-resource API keys with quota, monthly
  invoicing, Stripe Connect or similar
- Webhooks for terminal payment states
- CDP 4xx-as-verify-result handling (see v0.3.1 CHANGELOG Deferred)
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
