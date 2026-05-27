# STATUS

Last session: 2026-05-27
Last tag: v0.1.0

## Current state
Phase 1 stable, v0.1.0 cut. Real-network smoke green end-to-end
against cosmos-pay on Noble testnet `grand-1`. Repo public at
sudzikcoin/suverse-pay.

## Infrastructure
- Postgres on :5433, Redis on :6380 (Docker)
- To restart: cd /home/govhub/suverse-pay && docker compose up -d && pnpm db:migrate && pnpm db:bootstrap

## Tech debt (small, not urgent)
- CI badge in README after first green CI run on main

## v0.2+ release gate
- Coinbase CDP real-network smoke (needs CDP API key)
- Cross-provider fallback under real conditions (needs second
  reachable facilitator)
- Race-replay terminal state polish — duplicate /settle may transiently
  surface as `pending`. Phase 2 will hold the Redis lock through
  finalization.
- SIGHUP-style admin api_key rotation without server restart

## Phase 2 (when ready, do not start without explicit decision)
- MCP server at apps/mcp
- Race-replay terminal state fix
- Webhooks for settlement notifications

## How to resume work next session
1. cd /home/govhub/suverse-pay
2. claude
3. First prompt: "Read STATUS.md and CLAUDE.md, summarize current state, ask what to work on next"

## Out of scope (do not pursue without explicit decision from user)
- Outreach to x402 Foundation / Coinbase / Posthuman
- Production deploy
- Multi-tenancy with billing
- Native facilitator
