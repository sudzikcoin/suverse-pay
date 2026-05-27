# STATUS

Last session: 2026-05-26
Last commit: e39a2fd
Last tag: v0.1.0-rc.1

## Current state
Phase 1 published. Repo public at sudzikcoin/suverse-pay.
309 tests green, 14 commits, clean history, no secret warnings.

## Infrastructure
- Postgres on :5433, Redis on :6380 (Docker)
- To restart: cd /home/govhub/suverse-pay && docker compose up -d && pnpm db:migrate && pnpm db:bootstrap

## Tech debt (small, not urgent)
- Flaky timing test in services/orchestrator/src/health-check.test.ts:177 — rewrite with fake-timers
- GitHub Release from tag v0.1.0-rc.1 — gh release create v0.1.0-rc.1 --notes-file CHANGELOG.md
- CI badge in README after first green CI run on main

## Release gate to v0.1.0 (no RC suffix)
- Deploy cosmos-pay somewhere reachable (easiest: same Contabo, localhost:8402)
- Run real /settle against Cosmos testnet, verify tx on explorer
- Optionally: Coinbase CDP API key + real /settle against CDP testnet
- Create scripts/smoke/real/ mirroring smoke/mocked/ structure
- Then tag v0.1.0

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
