# B–E demand-map unblock — three-bucket pass

**Date:** 2026-06-22 · **Payer:** 0x3869 native USDC on Base · **payTo:** payto-005 `0xe903…b751`
**Source plan:** `REPORT-batch-007-groups-BCDE.md` (the ~63 blocked B–E endpoints).
**Commits:** `bdb9915` (wallet-pnl + live batch-007/008 source + CI fix) · `e0f8bb7` (batch-009 jupiter).
**CI:** GREEN — run 27920822836 (build+unit ✓, integration ✓). Main CI was RED before this pass; we fixed it (see §CI).

## TL;DR — what actually moved
The REPORT-007 premise was "~21 in-house endpoints to build." On inspection the
buildable-with-fresh-data core (5 endpoints) **was already built and live** as
batch-008 but **never committed to git** (registry imported untracked files —
the tree didn't build from a clean checkout). The *true* blocker on the
remaining ~16 is **data, not code**: frozen netflow windows, a stalled Solana
feed, no eth chain, and missing label classes. Fail-closed handlers for those
would 503 on every call — a runtime stub the key-gate forbids. So this pass:
committed the live source, built the one genuinely-buildable net-new in-house
endpoint (**wallet-pnl**), re-hosted+wrapped **Jupiter**, prepped the keyed
providers, and honestly re-bucketed the data-blocked rows.

**Net new live + CDP-indexed this pass: 2** (wallet-pnl, swap-quote-jupiter).
**Confirmed already-live + CDP-indexed: 5** (batch-008). **Zero settled-then-4xx.**

## BALANCE GATE — PASS
0x3869 = **$7.27 → $7.17** (2 settles @ $0.05; every failed settle attempt cost
$0 — no tx). Checked before every settle sub-batch. Never near dry.

---

## BUCKET 1 — IN-HOUSE HANDLERS

### Already live + CDP-indexed (batch-008, verified this pass — were uncommitted)
| slug | handler | source | price | CDP |
|---|---|---|---|---|
| smart-money-token-rankings | smart_money_token_rankings | sm_netflow_cache 30d | $0.05 | ✓ |
| smart-money-accumulation | smart_money_accumulation | sm_netflow_cache 30d | $0.05 | ✓ |
| smart-money-distribution | smart_money_distribution | sm_netflow_cache 30d | $0.05 | ✓ |
| smart-money-top-wallets | smart_money_top_wallets | sm_wallets eligible | $0.05 | ✓ |
| wallet-label-lookup | wallet_label_lookup | sm_wallet_labels | $0.05 | ✓ |

- **token-rankings-base #34 is already covered** — `smart_money_token_rankings`
  takes `{"chain":"base"}`; the base 30d netflow cache is fresh. No new endpoint.
- These were committed to git for the first time this pass (`bdb9915`).

### Built NEW this pass
| slug | handler | source | price | settle tx | CDP |
|---|---|---|---|---|---|
| **wallet-pnl** #53 | wallet_pnl | sm_wallets (90d/realized PnL, win rate, profit factor, drawdown, cadence, skill score/tier) | $0.05 | `0x022a27a9…b451552` | ✓ |

- EVM **or** Solana, chain auto-detected. Fail-closed preflight (503, no charge,
  if sm_wallets down); 422 schema-gate pre-settle; untracked wallet = clean
  `tracked:false` 200 (not an error). 16 unit tests. Full proxy suite 737/737.
- Settle returned upstream **200** (handler ran end-to-end on a real tracked
  wallet). Zero settled-then-4xx.

### Data-blocked (NOT code-blocked) — needs a feed/backfill, not a handler
Verified directly against the DB (2026-06-22):
- **Frozen netflow windows** — `sm_netflow_cache` 1h/24h/7d last computed
  base **13d** ago, solana **18d** ago (only 30d is kept fresh). Blocks:
  inflow-5min/1h/24h #38–40, token-activity #37, any short-window
  smart-money-netflow #31/32.
- **Solana sm_trades stalled ~1.5d** (newest trade 2026-06-20 10:29). Degrades
  wallet-trade-history #56, first-buyers #49 (data exists but not current).
- **No eth-chain data at all** in sm_wallets/sm_trades. Blocks
  wallet-reputation-eth #52, smart-money-netflow-eth, whale-transfers-eth.
- **Base cohort tiny** — sm_wallets base = 41 rows / 3 eligible. wallet-reputation-base
  #51 would be technically live but statistically thin.
- **Missing label classes** — sm_wallet_labels has cex/market-maker/bot populated
  but `is_contract`=0 and `is_deployer`=0 everywhere, and no KOL label. Blocks
  kol-flows #44 and any contract/deployer-specific endpoint.
- **Need real compute (engine + simple handler both can't)** — wallet-counterparties
  #57 (counterparty graph), wallet-net-worth-history #65 (no balance-history table),
  cross-chain #50, new-wallets #43, accumulation/distribution rankings cross-window.

> The moat play (per the map's §4) is fixing the smart-money tracker's short-window
> + Solana + eth + label coverage. That's a **tracker/data-pipeline workstream**,
> not a proxy wrap. Once those feeds are fresh, the handlers above are ~1 day of
> work each (the wallet-pnl/top-wallets pattern), but shipping them now = guaranteed
> 503s.

---

## BUCKET 2 — NEEDS KEY (prepped, NO stubs)

API keys go inline in **`/etc/suverse-pay/proxy.env`** (already `chmod 600`,
owner govhub), one `KEY=value` line each, then `kill $(systemctl show -p MainPID
--value suverse-pay-proxy.service)` to reload. Convention: `<PROVIDER>_API_KEY`
(matches the live `ETHERSCAN_API_KEY` / `GOPLUS_API_KEY` / `HELIUS_API_KEY`).

| provider | unlocks | free tier? | signup | env var (in /etc/suverse-pay/proxy.env) |
|---|---|---|---|---|
| **Etherscan PAID** | whale-transfers #45/46, wallet-age #61, EVM multichain | yes, but Base/multichain returns "upgrade plan" — needs paid | https://etherscan.io/apis | `ETHERSCAN_API_KEY` (replace existing free-tier key, same var) |
| **Birdeye** | Solana smart-money/whale enrichment #33/35/47 | yes (limited rate) | https://docs.birdeye.so | `BIRDEYE_API_KEY` (new) |
| **Zerion** | wallet-token-holdings #54 | yes (dev tier) | https://developers.zerion.io | `ZERION_API_KEY` (new) |
| **Octav** | wallet-portfolio-value #55 | limited / contact | https://octav.fi | `OCTAV_API_KEY` (new) |

Notes:
- **Kalshi** (#21–26) — already LIVE (batch-006 Group A: kalshi_events/markets/
  orderbook/trades/series/event-detail all active). No new key needed for the
  current public endpoints; a paid `KALSHI_API_KEY` would only raise limits.
- **wallet-identity-map #62 / bluepages** — policy-excluded (PII), not pursued.

Drop the key(s), tell me which file(s) you populated, and the next pass wraps
those endpoints (each is a declarative GET wrap once the key exists).

---

## BUCKET 3 — ENGINE-CAN'T (fixed what's cheap)

### Wrapped this pass
| slug | upstream | price | settle tx | CDP |
|---|---|---|---|---|
| **swap-quote-jupiter** #78 | lite-api.jup.ag/swap/v1/quote (GET) | $0.05 | `0xcaa31d7e…a8d6a` | ✓ |

- Re-hosted from the dead `quote-api.jup.ag` to `lite-api.jup.ag` — probed 200,
  wrapped declaratively (batch-009), live (402 + input_schema + extensions.bazaar),
  settle returned upstream **200**, CDP-indexed. Zero settled-then-4xx.

### Still blocked (one-line each, for a later pass)
- **jupiter-perps-oi #72** — Jupiter `price/v2` returns 404 on lite-api (endpoint
  moved/removed); needs a new OI source. *needs re-source.*
- **hyperliquid-funding / vault-positions #70/71** — Hyperliquid `/info` probes
  200 but is **POST-only**; the declarative engine is GET-only. *needs a thin
  POST internal_handler* (one upstream call, no compute — quick next pass).
- **Aggregation/compute rows** (combine/score multiple calls — engine picks
  fields from ONE GET): whale-token-concentration #48, perp-funding-all #66,
  perp-funding-arb #67, token-rug-score #92, dex-arb-routes #81, predmarket-arb.
  *needs an aggregation handler each.*

---

## CI — fixed a pre-existing red
Main CI had been **red on the last 3+ commits** from `tests/token-check.test.ts:844`:
the "fresh cohort" fixture `FRESH_FEED` was anchored to the test's fixed `NOW`
constant while the handler computes elite-feed lag against the real `Date.now()`,
so once wall-clock time passed `NOW+48h` the fixture rotted into ">48h cohort
silent" and the assertion flipped (`no_signal_cohort_silent` vs `no_elite_interest`).
Re-anchored `FRESH_FEED` to `Date.now()` (test-only, defuses the time-bomb). Full
proxy suite **737/737**, and run 27920822836 is **green** end-to-end.

## VERIFY (no self-report)
- **Bucket 1:** 5 batch-008 live + CDP-indexed (verified) · 1 built new (wallet-pnl)
  → committed `bdb9915`, settled `0x022a27a9…`, CDP-indexed, upstream 200, 16 tests.
  ~16 rows data-blocked (enumerated, with the DB freshness evidence).
- **Bucket 2:** 4 providers prepped with exact /etc path + env var; 0 stubs.
- **Bucket 3:** 1 wrapped + CDP-indexed (swap-quote-jupiter, `0xcaa31d7e…`);
  3 classes listed as needs-handler / needs-re-source.
- **Settled-then-4xx:** 0 (both new settles returned upstream 200).
- **Dup slugs:** 0 (checked vs 488 live configs before each seed).
- **Balance:** $7.27 → $7.17. **CI:** green. **Commits:** bdb9915, e0f8bb7.

---

## POST-SESSION VERIFICATION & CORRECTION (2026-06-22, addendum)

The session dropped mid-task; this addendum re-verifies every claim above against
git, CI, the live DB, and on-chain, and records one correction.

**Verified true:** commits `bdb9915` + `e0f8bb7` on main; CI green (runs
27920822836 + 27921110605, build+unit+integration ✓); all 6 in-house handlers
(`smart_money_token_rankings/accumulation/distribution/top_wallets`,
`wallet_label_lookup`, `wallet_pnl`) committed to `apps/proxy/src/handlers/*`
and registered in `registry.ts`; both new settles real and `settled` in
`facilitator_payments` (`0x022a27a9…` wallet-pnl, `0xcaa31d7e…` jupiter, both
$0.05, upstream 200); 0 settled-then-4xx; balance was $7.17 as stated.

**CORRECTION — pricing gap found & fixed.** The Bucket-1 table above stated all
batch-008 endpoints at $0.05. The DB actually still carried the cheap demand-map
prices: `smart-money-token-rankings/accumulation/distribution` = $0.03 and
`wallet-label-lookup` = $0.02 — below the $0.05 pricing-rule floor, in BOTH
`seller_proxy_configs.price_atomic` and `catalog_listings.price_atomic_{min,max}`.
Fixed this pass:
- `scripts/seed/reprice-batch-008.sql` (commit `e917329`, pushed, CI green) —
  idempotent slug-scoped UPDATE of all 4 to 50000 atomic in both tables.
- Proxy restarted (MainPID flush); live 402 + openapi.json now advertise $0.05.
- CDP price refreshed via `index-batch --force` re-settle at the new price:
  token-rankings `0x95782aca…`, accumulation `0x79f1ab4d…`, top-wallets
  `0xde04a01b…`, wallet-label-lookup `0x6464054d…`, distribution `0xc1f08089…`
  (all upstream 200; 1 transient `settle_failed` no-charge cleared on retry;
  CDP listing price propagates over hours — merchant count stayed 137 = already
  indexed). All 5 batch-008 endpoints now $0.05 across config + catalog + live
  402 + CDP settle.

**Balance:** $7.17 → **$6.82** (7 re-index settles @ $0.05 = $0.35; 2 endpoints
double-settled harmlessly, all 200). Still well above the gate — no top-up needed
for what was built. **Settled-then-4xx this pass: 0.**
