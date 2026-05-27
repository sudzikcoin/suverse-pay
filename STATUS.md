# STATUS

Last session: 2026-05-27
Last tag: v0.2.0

## Current state
**Phase 2 complete. v0.2.0 released.** MCP server at `apps/mcp` with
real on-chain verification:

- Real `MsgExec(MsgSend)` broadcast on Noble testnet `grand-1`
  through the MCP `pay_and_call` flow, signed by the in-process
  Cosmos signer, settled via cosmos-pay, response returned to the
  agent
- Idempotency proven on-chain: replay returns the same `paymentId`
  and `txHash` with `idempotentReplay: true` and DOES NOT broadcast
  a second transaction
- 40 MCP tests + 32 discovery tests + 18 signer tests, all green
- All 4 smoke suites pass: `mocked` (10 steps), `real` (9 steps),
  `mcp-mocked` (7 steps), `mcp-real` (4 steps)

## Infrastructure
- Postgres on :5433, Redis on :6380 (Docker)
- To restart: `cd /home/govhub/suverse-pay && docker compose up -d && pnpm db:migrate && pnpm db:bootstrap`

## Running services
- cosmos-pay facilitator at :8402 (Go, separate repo)
- suverse-pay API at :3000 (this repo, `apps/api`)
- MCP server at :3100 (this repo, `apps/mcp`) — only when needed

The cosmos-pay and suverse-pay processes survive across sessions;
restart per their respective READMEs if dead. The MCP server is
spawned on-demand by the mcp-real / mcp-mocked smoke suites and
isn't normally running idle.

## Phase 3 (when ready, do not start without explicit decision)
- Solana signer + adapter (largest live x402 volume — see IDEAS.md
  item 4)
- Coinbase CDP real-network smoke (needs CDP API key)
- PayAI adapter as third facilitator (Solana, IDEAS.md item 5)
- Race-replay terminal state polish (Phase 1 known gap)
- SIGHUP-style admin api_key rotation without server restart

## How to resume work next session
1. `cd /home/govhub/suverse-pay`
2. `claude`
3. First prompt: "Read STATUS.md and CLAUDE.md, summarize current
   state, ask what to work on next"

## Out of scope (do not pursue without explicit decision from user)
- Outreach to x402 Foundation / Coinbase / Posthuman
- Production deploy
- Multi-tenancy with billing
- Native facilitator settlement (Phase 5+)
