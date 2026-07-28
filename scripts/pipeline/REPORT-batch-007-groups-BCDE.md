# Batch-007 — Groups B/C/D/E wrap run (consolidated)

**Date:** 2026-06-22 · One session (all 4 group-prompts landed here, not 4 parallel sessions).
**Payer:** 0x3869 native USDC on Base. **payTo this batch:** payto-005 `0xe903…b751`.
**Source plan:** `launchloop/next-batch-demand-map.md` items 31–100 (Groups B–E, ~70 endpoints).

## TL;DR
The map's ~70 B–E endpoints assume capabilities this pipeline does **not** have. The
declarative engine is a **GET-only, field-pick HTTP proxy** — no DB access, no POST,
no aggregation/compute. Applying the key-gate honestly, **only 7 of ~70 are genuinely
wrappable right now**; they shipped as **batch-007**. The other ~63 are blocked, split
into three real buckets (needs-key / needs-in-house-handler / engine-can't). This is
exactly the "wrap free now, list the rest for a second pass" outcome the key-gate is for —
just a much larger "rest" than the map implied.

## BALANCE GATE — PASS
0x3869 = **$9.65 USDC + gas** at start. Batch-007 indexing cost ≈ **$0.22** (7 settles
@ their prices). Never near dry. (Top-up to $15–20 was declined earlier — not needed.)

## SHIPPED — batch-007 (7 endpoints, all upstreams probed 200 before any spend)
| slug | group | upstream (free/keyed) | price | category |
|---|---|---|---|---|
| token-safety-eth | E | GoPlus token_security/1 [F, no auth] | $0.05 | token-risk |
| token-safety-base | E | GoPlus token_security/8453 [F] | $0.05 | token-risk |
| token-authority-solana | E | GoPlus solana/token_security [F] | $0.05 | token-risk |
| token-quicklook | E | DexScreener tokens [F] | $0.02 | token-risk |
| wallet-scam-check | C | GoPlus address_security [F] | $0.03 | wallet-analytics |
| dex-trending-pools | D | GeckoTerminal trending_pools [F] | $0.01 | dex-analytics |
| dex-new-pools | D | GeckoTerminal new_pools [F] | $0.01 | dex-analytics |

- **GoPlus works unauthenticated** (free rate tier) — no key injection needed; we also hold a key if limits bite.
- All 7 verified live (probe-batch: 7 OK / 0 fail) → registered (unpaid call = 402, not 404) → indexed via real Base settle.
- **Zero settled-then-4xx**: every settle that fired returned upstream 200 (confirmed in `proxy_request_logs`).
- No duplicate slugs (checked vs 476 live configs).

## SKIPPED — needs API key (we lack working creds)
- **Kalshi** (B/A-adjacent, items 21–26): no Kalshi key. *needs key: Kalshi*
- **Zerion** (wallet-token-holdings #54), **Octav** (wallet-portfolio-value #55),
  **bluepages/identity** (wallet-identity-map #62), **wallet-nft-holdings #63**: *needs key: Zerion / Octav / identity provider*
- **Etherscan multichain** (whale-transfers #45/46, wallet-age #61, etc.): we hold an Etherscan key
  but it is **free-tier — Base/multichain returns "upgrade your plan"**. *needs key: Etherscan PAID plan*
- **Birdeye** (Solana smart-money/whale enrichment #33/35/47): no Birdeye key. *needs key: Birdeye*

## SKIPPED — needs in-house handler (NOT a declarative wrap)
These are `[H]` rows that read our own `sm_wallets` / `sm_trades` data. The pipeline has **no DB
path** — it can only proxy an external URL. Wrapping them now would be a **stub** (key-gate forbids).
They need real `internal_handler` code (mig-025 style), a separate workstream:
- **Group B, ~14 rows:** smart-money-netflow-base/eth #31/32, token-rankings-base #34, top-wallets #36,
  token-activity #37, inflow-5min/1h/24h #38–40, accumulation/distribution #41/42, new-wallets #43,
  kol-flows #44, first-buyers #49, cross-chain #50.
- **Group C, ~7 rows:** wallet-pnl #53, wallet-trade-history #56, wallet-counterparties #57,
  wallet-label #64, wallet-net-worth-history #65, wallet-reputation-base/eth #51/52 (H+K).

## SKIPPED — engine can't (GET-only / no compute / host down)
- **POST-only upstreams:** Hyperliquid info API (hyperliquid-funding/vault-positions #70/71) — engine is GET-only.
- **Jupiter** (swap-quote #78, jupiter-perps-oi #72): old `quote-api`/`price` hosts now 000/404 (moved to lite-api); needs re-host + re-probe.
- **Aggregation/compute rows** (engine only picks fields from one GET response):
  netflow *rankings*, whale-token-concentration #48, perp-funding-*all* #66, perp-funding-arb #67,
  token-rug-score #92, dex-arb-routes #81, predmarket-arb — all require combining/scoring multiple calls.
- **Conceptual dupes of existing dead rows** (not re-wrapped): perp-open-interest (`suverse-perp-open-interest` exists),
  perp-funding (`suverse-perp-funding` exists), token-check reprice #99 (that's a config change, not a wrap).
- **DefiLlama /pools** (yields #77): works but returns ALL pools unfiltered (no query support) → multi-MB payload for a $0.01 call; dropped as not worth the egress.

## What a second pass unlocks (priority order)
1. **Buy an Etherscan PAID plan** → unlocks ~6 EVM whale/wallet endpoints (Base/multichain).
2. **Build the in-house smart-money handlers** (Group B core) — this is our actual moat (the map's whole §4 thesis) but it's *engineering*, not wrapping. ~14 endpoints off `sm_wallets`/`sm_trades`.
3. **Birdeye key** → Solana smart-money/whale enrichment (#33/35/47).
4. **Re-host Jupiter** to lite-api.jup.ag, re-probe → swap-quote-jupiter + jupiter-perps-oi.
5. **Kalshi key** → completes the Group A prediction-market set already in batch-006.

## Honest note (carried from the operator's own framing)
This adds 7 demand-aligned listings (token-risk verdicts fill our EVM gap; the map flagged
our Solana-only token-check as a coverage hole). But per the day's conclusion: **listings ≠ sales.**
The real lever in B/C is the in-house smart-money/wallet handlers (moat data), which this
GET-proxy pipeline structurally cannot produce. Measure batch-007 by **distinct-IP conversion**,
not count — and decide the in-house build on whether Group A (batch-006) actually converts first.

LaunchLoop: https://api.suverse.io/launchloop/
