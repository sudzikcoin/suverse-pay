# Batch-008 — in-house handlers + full A/B/C classification of B–E

**Date:** 2026-06-22 · One session. Payer 0x3869 (Base native USDC). payTo payto-005 `0xe903…`.
**Source:** the ~63 endpoints `REPORT-batch-007-groups-BCDE.md` left unwrapped (demand-map items 31–100).
**Method:** in-house rows → `internal_handler` (wallet-reputation pattern: validator → fail-closed preflight → handler, pure fns + tests). NOT URL wraps.

## TL;DR
The honest blocker was never just "needs a key" — it splits four ways once you check the **actual data**: (1) buildable in-house now, (2) in-house but the **data is stale/missing/never indexed** (a tracker-worker gap, not a key), (3) needs an external key, (4) free & URL-wrappable in a follow-up declarative batch. I **built + shipped the 5 in-house endpoints whose data is genuinely fresh** (batch-008). The rest are listed below with exactly what each needs.

## DATA REALITY (measured, drives everything below)
- `sm_trades`: **Base fresh** (today, ~10k/24h); **Solana stale ~1.5d** (0 rows/24h).
- `sm_netflow_cache`: **only the 30d window is fresh** (both chains, minutes old); **1h/7d/24h windows FROZEN 2-3 weeks**.
- `sm_wallets`: Solana 292 eligible (fresh-ish); **Base only 41 scored / 3 eligible**.
- **No `eth` chain anywhere**; **no KOL label column** (only contract/cex/mm/deployer/lp/bot); **no counterparty, no net-worth-history, no holder table, no deployer-history**.

## ✅ BUILT NOW — batch-008 (5 internal_handlers, fresh data)
| slug | handler | source (fresh) | price | map # |
|---|---|---|---|---|
| smart-money-token-rankings | smart_money_token_rankings | sm_netflow_cache 30d + token meta | $0.03 | 34/35 |
| smart-money-accumulation | smart_money_accumulation | sm_netflow_cache 30d (net>0) | $0.03 | 41 |
| smart-money-distribution | smart_money_distribution | sm_netflow_cache 30d (net<0) | $0.03 | 42 |
| smart-money-top-wallets | smart_money_top_wallets | sm_wallets (eligibility gate) | $0.05 | 36 |
| wallet-label-lookup | wallet_label_lookup | sm_wallet_labels | $0.02 | 64 |
- All fail-closed (preflight proves the table BEFORE settle → 503 no-charge if down), schema-gated 402 (input_schema in challenge), 422 pre-challenge on bad chain/address, idempotent UPSERT seed, chain param (base|solana), `data_quality.stale` flag so a frozen worker is visible not hidden.
- `chain=base|solana`; an empty body is a valid defaulted call AND still hits the 402 (crawler-visible).
- **top-wallets exposes addresses by design** (it's a copy-trading leaderboard — the sniperx shape) but only ELIGIBLE wallets + aggregates; no off-chain identity, ever.

## A — IN-HOUSE, buildable but DEFERRED (data thin/stale/lower-value, no key needed)
- smart-money-token-activity (#37) — overlaps token-rankings; per-token sm_trades agg, Solana trades stale.
- smart-money-new-wallets (#43) — sm_wallets by discovered_at; Base universe tiny (41).
- smart-money-first-buyers (#49) — sm_tokens_tracked (only 162) + earliest sm_trades; Solana stale.
- wallet-reputation-base (#51) — extend existing Solana verdict to Base; only 3 eligible Base wallets (thin).
- wallet-pnl (#53) — sm_wallets.pnl_90d, tracked wallets only; already exposed by wallet-reputation.

## A-BLOCKED — IN-HOUSE but DATA/WORKER GAP (needs the tracker fixed, NOT a key)
- smart-money-inflow-5min/1h/24h (#38–40) — the 1h/24h netflow windows are **frozen 2-3 wks**; no 5min window exists. *Fix: tracker must recompute short windows.*
- smart-money-kol-flows (#44) — **no KOL label** in sm_wallet_labels. *Fix: add is_kol labeling.*
- smart-money-netflow-eth (#32), wallet-reputation-eth (#52) — **no eth indexing**. *Fix: index eth in the tracker.*
- smart-money-cross-chain (#50) — no cross-chain actor link (clusters are per-chain).
- wallet-counterparties (#57) — sm_trades has no counterparty leg (swaps vs pools).
- wallet-net-worth-history (#65) — no historical balance snapshots.
- token-deployer-history (#93), token-top-holder-labels (#94) — no deployer/holder tables.
- *Also note Solana sm_trades has stalled ~1.5d — worth checking the Solana indexer.*

## ALREADY SERVED (don't rebuild — existing endpoints cover these)
- smart-money-netflow-base/solana (#31/33) → `smart-money-base`, `smart-money-netflow` (proxy → tracker :3200).
- wallet-trade-history (#56) → `suverse-wallet-history` (helius). perp-open-interest (#68) → `binance-open-interest` / `suverse-perp-open-interest`. dex-pool-apy-tvl (#77) → `defillama-yield-pools`. perp-funding (#66) → `binance-funding(-batch)`.

## FREE & URL-WRAPPABLE — no key, just a follow-up declarative batch-009 (batch-007 style)
GoPlus (we hold key, works unauth): token-holder-concentration (#88), token-honeypot (#91), token-tax-detect (#95) — *same GoPlus token_security object, relabeled; low differentiation.* wallet-approval-risk (#59) — GoPlus `token_approval_security` (fix URL).
GeckoTerminal/DexScreener (free): dex-pool-health (#75), dex-token-liquidity (#83), token-age-liquidity (#96).
Binance (free): perp-liquidations (#69, allForceOrders), perp-skew (#84), funding-history (#85).
Drift/GMX (free): drift-markets (#73), gmx-positions (#74). Hyperliquid (#70/71) — free but **POST-only → needs an internal handler, not the GET engine.**

## B — NEEDS API KEY  (provider · free tier? · cost · EXACT /etc path → as `NAME=value` in that file, already chmod 600)
- **Zerion** — wallet-token-holdings #54, wallet-portfolio-value #55. Signup https://zerion.io/api · free dev tier yes · paid from ~$ on volume → `ZERION_API_KEY` in `/etc/suverse-pay/proxy.env`
- **Octav** — wallet-portfolio-value #55 (alt). https://octav.fi · waitlist/paid → `OCTAV_API_KEY` in `/etc/suverse-pay/proxy.env`
- **Kalshi** — kalshi-* (Group A remainder, already half in batch-006). https://kalshi.com/sign-in (API key in profile) · free · → `KALSHI_API_KEY` + `KALSHI_API_SECRET` in `/etc/suverse-pay/proxy.env`
- **Etherscan PAID** — whale-large-transfers-base/eth #45/46, wallet-age-activity #61, wallet-first-funder #58. We hold an Etherscan key but it's **free-tier (Base/multichain blocked)**. https://etherscan.io/apis · Standard plan ~$199/mo for multichain → replace `ETHERSCAN_API_KEY` value in `/etc/suverse-pay/proxy.env`
- **Coinglass** — perp-liquidations #69 (richer than Binance free). https://coinglass.com/pricing · paid → `COINGLASS_API_KEY` in `/etc/suverse-pay/proxy.env`
- **Birdeye** — smart-money Solana enrichment #33/35/47. https://birdeye.so (BDS) · free tier limited · paid by CU → `BIRDEYE_API_KEY` in `/etc/suverse-pay/proxy.env`
- **wallet-identity-map #62 (bluepages/ENS-social)** — ⚠️ **POLICY-EXCLUDED, not just a key.** wallet-reputation's privacy guard forbids off-chain identity enrichment. Recommend NOT building; if reversed, it's a deliberate policy decision.

## C — NEEDS PER-CALL UPSTREAM SPEND (margin check before building)
- **Helius** (we HOLD the key) — whale-large-transfers-solana #47, wallet-nft-holdings #63, wallet-first-funder (solana) #58. Cost: Helius paid plans bill per credit; each call = 1+ enhanced-tx/RPC credit. At our token prices ($0.02–0.10) margin is fine for 1 call/request; **#47/#63 may fan out to several calls — check before shipping.** Key already at `HELIUS_API_KEY` in `/etc/suverse-pay/{proxy,api}.env`.
- **Hyperliquid** (#70/71) — free API but **POST-only**; needs a small internal handler (no key, no per-call $). Buildable, just not via the GET declarative engine.

## VERIFY (batch-008)
- 5 handlers built; `pnpm --filter proxy build` (tsc) **green**; **15/15 new unit tests pass**; full suite **705 pass / 1 fail** — the 1 failure is pre-existing `token-check.test.ts` (elite-feed-staleness assertion, unrelated to this change, untouched file).
- All 5 register live (unpaid POST → **402**, not 404); input_schema present in challenge; bad chain → **422** pre-challenge.
- Indexing: see `/tmp/index-008.log`; settles use valid sampleRequests (verified the SQL returns rows for each) → no settled-then-4xx; idempotent `--state` prevents double-settle; CDP lag is normal (poll read-only).
- No duplicate slugs (checked vs 476 live configs). Balance gate PASS ($9.43 vs ~$0.16 needed).

LaunchLoop: https://api.suverse.io/launchloop/
