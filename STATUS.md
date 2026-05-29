# STATUS

Last session: 2026-05-29
Last tag: **v0.4.0** (v0.5.0-alpha in development)

## Current state

**Phase 5 STARTED.** Block 4 Sub-task 1 shipped: customer dashboard
MVP (Next.js 15 app under `apps/dashboard`, OAuth via Google + GitHub
through NextAuth.js v5, four panels, multi-tenant from day one).
Dashboard NOT yet deployed — needs DNS + OAuth registrations + env
vars before first sign-in works; full operator runbook in
`apps/dashboard/README.md`.

Phase 4 baseline below (still current).

**Phase 4 closed. v0.4.0 released — "Multi-protocol multi-chain".**

Gateway is now three protocols deep (x402, MPP, t402) across 11
blockchain namespaces and 7 facilitator adapters. Cosmos mainnet
reachable off-the-shelf via t402-io (Block 1 Sub-task 5's funded-
facilitator approach no longer required).

Build: **19/19 packages green**. Tests: **36/36 turbo tasks green**.

## Phase 4 — CLOSED (2026-05-29)

### What shipped

- **7 facilitator adapters** (was 3 entering Phase 4):
  cosmos-pay, coinbase-cdp, payai, thirdweb-x402, binance-x402,
  bofai-x402, t402-io. Plus mpp-stripe (different protocol family).
- **11 network namespaces** (was 4 entering Phase 4):
  eip155, tron, solana, cosmos, aptos, near, polkadot, stacks,
  stellar, tezos, ton.
- **17 EVM mainnets** routed (was 4 entering Phase 4):
  Base, Polygon, Arbitrum, World Chain, Avalanche, Ethereum, Optimism,
  BNB Chain, XDC, Monad, Sonic, Sei, Abstract, IoTeX, Celo, Ink,
  Linea + Tempo (18 with Tempo).
- **Multi-protocol surface**: x402 + MPP + t402.
- **First Cosmos mainnet route** (`cosmos:noble-1` via t402-io).
- **First non-EVM, non-Solana, non-Cosmos namespace** (TRON via BofAI).
- **Permit2 PermitWitnessTransferFrom signing** in `signer-evm` —
  unlocks USDT path on every EVM chain we route.
- **USDT registry** across 9 EVM chains + on-chain verification.
- **Internal Grafana observability stack** — 12-panel dashboard,
  prom-client metrics endpoint, 30d Prometheus retention.

### Sub-task index

| Block / Sub-task | Commit |
| --- | --- |
| Block 1 — Sub-task 1: World Chain + adapter design doc | `62e66e3` |
| Block 1 — Sub-task 2: PayAI EVM failover + Avalanche routes | `5dd4575` |
| Block 1 — Sub-task 3: Thirdweb x402 adapter (Ethereum + Optimism) | `f536dc0` |
| Block 1 — Sub-task 4: Internal Grafana dashboard | `b401cc8` |
| ~~Block 1 — Sub-task 5: Cosmos mainnet (funded facilitator)~~ | deferred → off-the-shelf via t402-io (Block 2 Sub-task 10) |
| Block 2 — Sub-task 5: Thirdweb config expansion (+9 networks) | `92185d0` |
| Block 2 — Sub-task 6: Permit2 in signer-evm + USDT registry | `341b79a` |
| Block 2 — Sub-task 7: Binance x402 adapter (BNB Chain) | `5c2f6ba` |
| Block 2 — Sub-task 8: BofAI / TRON adapter | `1ba0136` |
| Block 2 — Sub-task 9: MPP protocol adapter (Stripe + Tempo) | `dff8c64` |
| Block 2 — Sub-task 10: t402-io universal USDT adapter | `200f022` |
| Block 3 — Final wrap + v0.4.0 tag | (this commit) |

### Coverage summary

| Tier | Networks |
| --- | --- |
| Battle-tested (real on-chain smoke) | Cosmos `noble-grand-1` testnet, Solana devnet, EVM `eip155:84532` Base Sepolia |
| Wired against documented spec (mainnet smoke deferred to Phase 5) | EVM mainnets 1, 10, 50, 56, 137, 143, 146, 480, 1329, 2741, 4217, 4689, 8453, 42161, 42220, 43114, 57073, 59144; TRON mainnet + Nile testnet; `cosmos:noble-1` mainnet |
| Capability-advertised (signer pending Phase 5) | TON, NEAR, Aptos, Tezos, Polkadot, Stacks, Stellar — all via t402-io |

### Carry-overs to Phase 5

**Native signers** (largest cluster, in priority order):
1. `signer-tron` — unlocks BofAI's TRON `exact` / `exact_permit` /
   `exact_gasfree` paths end-to-end
2. EIP-2612 Permit signer for EVM — unlocks
   `eip155:*:exact_permit` routes + Peaq + Berachain
3. `signer-ton`, `signer-near`, `signer-aptos`, `signer-stellar`,
   `signer-tezos`, `signer-polkadot`, `signer-stacks` — via t402-io's
   advertised mechanisms

**Real-network mainnet smokes** (gated on credentials + funding):
- Thirdweb Nexus key — unlocks 11 EVM mainnets
- Binance Pay merchant account — unlocks BNB Chain
- BofAI public facilitator — open access, ready when signer-tron lands
- Stripe MPP REST surface — unlocks Tempo USDC + SPT fiat
- t402-io API key — unlocks Cosmos noble-1 mainnet + Solana mainnet
  USDT + 5 EVM USDT chains

**Protocol surfaces**:
- MPP `/mpp/*` HTTP routes (waiting on Stripe REST surface)
- Discovery layer multi-source aggregator (x402 + MPP + t402 catalogs)

**Infrastructure**:
- ~~Multi-tenant customer dashboard~~ ✓ MVP shipped in Phase 5 Block 4 Sub-task 1 (NOT yet deployed — needs DNS + OAuth)
- Self-serve resource API key signup (Phase 5 Block 4 Sub-task 2 — next)
- Per-settle fee mechanism for revenue
- Native facilitator settlement (isolated service with its own keys)
- AP2 authorization layer
- AI-assisted routing once payment_attempts volume justifies it

## Phase 5 progress

| Block / Sub-task | Status |
| --- | --- |
| Block 4 Sub-task 1: Customer dashboard MVP (OAuth + 4 panels) | ✓ in this commit |
| Block 4 Sub-task 2: Self-serve API key signup | next |
| Block 4 Sub-task 3+: TBD (signers, smokes, …) | pending |

Operator runbook for the dashboard:
1. Add DNS A-record `suverse-pay.suverse.io → <server IP>`
2. Register Google + GitHub OAuth apps (callback URLs in `apps/dashboard/README.md`)
3. Set env vars (`NEXTAUTH_SECRET`, `*_CLIENT_ID`, `*_CLIENT_SECRET`, `DATABASE_URL`)
4. `pnpm db:migrate` to apply `003_dashboard.sql`
5. Deploy via Vercel (recommended) or self-host (`pnpm --filter @suverse-pay/dashboard build && start --port 3002` behind nginx)

## Infrastructure
- Postgres on :5433, Redis on :6380 (Docker)
- Grafana on :3030, Prometheus on :9090 (observability profile, opt-in)
- To restart core: `cd /home/govhub/suverse-pay && docker compose up -d && pnpm db:migrate && pnpm db:bootstrap`
- To bring up observability: `docker compose --profile observability up -d grafana prometheus`

## Running services
- cosmos-pay facilitator at :8402 (Go, separate repo)
- suverse-pay API at :3000 — admin REST surface + public
  `/facilitator/*` x402 routes. `.env` must be sourced into the
  process so the adapter env vars are read at boot.
- MCP server at :3100 (spawned on-demand by `mcp-*` smoke suites)

## EVM test wallet (for real-evm smoke)
The smoke suite uses a dedicated Base Sepolia test wallet whose
mnemonic lives at `.env.evm-sepolia` (mode 600, gitignored). Address:
`0xA2F8a871AfDC463aaEf5FAe8284d900f4d02538E`. Refill via the Coinbase
CDP faucet when USDC balance < `SMOKE_REVM_AMOUNT_ATOMIC × 3`.

## How to resume work next session
1. `cd /home/govhub/suverse-pay`
2. `claude`
3. First prompt: "Read STATUS.md and CLAUDE.md, summarize current
   state, ask what to work on next"

## Out of scope (do not pursue without explicit decision from user)
- Outreach to x402 Foundation / Coinbase / Stripe / t402-io / BofAI
- Production deploy
- Native facilitator settlement (Phase 5+)
