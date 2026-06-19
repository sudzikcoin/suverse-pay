# Batch-003 — First 100/day Run On The Fixed Auto-Indexing Pipeline

**Date:** 2026-06-19 · **Repo:** suverse-pay · **payTo:** `0x7d7cE550251fd81457Bfe9afB40c800C2CD50A73` (minted dedicated → clean 0→100 measurement)

## Verdict
**PASS.** 100 endpoints wrapped + auto-indexed through the fixed pipeline.

| Acceptance check | Result |
|---|---|
| **Indexing in CDP merchant** | **100 / 100 (100%)** — well above the 95% stop-bar |
| **Shared-config regression** | **none** — batch-001 (24) + batch-002 (50) still serve `402 + 3 accepts`; registry loads **229 handlers** (128 + 100 + 1 e2e), no collision; build 25/25 + 14 engine tests green |
| **Settled-then-4xx** | **2** settled-then-**504** (transient), **both auto-refunded** (Task-57) → net-zero. Root-caused + fixed (below). |

The STOP condition is "indexing < ~95%" — indexing came in at **100%**, so the run is a success and we did **not** stop. The 2 settled-then-504 are a caveat I'm flagging honestly, not endpoint defects.

## What ran
100 fresh free-to-wrap starred endpoints, all single-hop GET no-auth, authored via `author-batch-003.mjs`, probed to **100/100 upstream-200** by `probe-batch.mjs` (7 dud upstreams swapped pre-seed: NLM icd10pcs 404, deprecated Wikipedia /related, throttled Semantic Scholar, ipwho.is CORS-gated, etc.), then pushed through the **fixed pipeline**:
`author → probe → wrap-batch (auto payTo from pool) → deploy-batch-003.sh (seed + restart + per-endpoint auto-index loop)`, run detached in the background.

Category spread: World Bank indicators 30, health (NLM clinical tables / openFDA / RxNorm / disease.sh) 18, food (TheMealDB / TheCocktailDB / OpenFoodFacts) 10, geo 8, sports 7, books 5, civic/social 5, treasury / SEC / science / culture / knowledge / forex / weather / games the rest.

## Indexing convergence (the real story)
The CDP **facilitator throws transient `502 / facilitator_error` under sustained settle load** (~40–50% during a burst — buyer never charged, logged `settle_failed` with no tx), and **CDP indexing is eventually-consistent (multi-minute latency)**. One pass can't index 100 endpoints, so the loop settles → waits → retries only the still-dark:

| Pass | settled | failed | cumulative indexed |
|------|---------|--------|--------------------|
| deploy 1 | 51 | 49 | 40 |
| deploy 2 | 36 | 24 | 83 |
| converge 1 | 14 (of 17 left) | 3 | (latency) |
| converge 2 | 16 (re-settles) | 1 | → **100** |

Two bugs surfaced and were fixed in the pipeline:
1. **False-convergence grep.** The deploy loop's convergence check `grep '0 need indexing settle'` matched the substring inside "6**0 need indexing settle**", so it declared "converged" at pass 2 (83/100). Fixed → `grep -E 'scope; 0 need indexing settle'`. I resumed the loop manually to reach 100.
2. **Re-settle under latency = wasted settles + the only 2 settled-then-504.** When CDP latency exceeds the inter-pass wait, the CDP skip-set is still stale, so a pass re-settles an already-settled endpoint — re-calling its upstream. The 2 settled-then-504 (`suverse-openlibrary-isbn`, `suverse-openlibrary-authors`) came from openlibrary.org timing out on such a **re-settle**. Fixed: `index-batch.mjs` now keeps a **campaign `--state` file** of slugs it has settled and skips them on every later pass — each endpoint settles **at most once per campaign**, regardless of CDP lag. Inter-pass wait also bumped 180s → 240s, passes 6 → 8.

So the durable pipeline now: per-endpoint settle, idempotent vs CDP **and** vs a campaign state file, paced, anchored convergence check. A repeat 100-run would not produce the wasted re-settles or the re-settle-induced upstream errors.

## The 2 settled-then-504, in full
- Both are `suverse-openlibrary-*`, $0.002 each, `upstream_status=504` (openlibrary.org exceeded our 12s timeout under load — transient; both probed 200 pre-seed and are indexed + healthy now).
- The **Task-57 refund worker refunded them** (5 `refunded` rows in the window) → the buyer wallet was made whole; net-zero loss.
- They are settle-time transients, not wrap defects. With the state-file fix they can't recur from re-settling.

## payTo rotation in action
`wrap-batch` read `activePayTo` from `/etc/suverse-pay/payto-pool.json` and assigned batch-003 to the freshly-minted `0x7d7cE550…` (key chmod 600 at `/etc/suverse-pay/payto-003.key`). Clean 0→100 measurement; pool now has 3 service payTos. Soft cap 150 (evidence-based — 133 already proven to index on one payTo). At 100/day, each batch rotates to its own payTo.

## Cost
~100 successful settles × ~$0.0022 avg ≈ $0.22 principal (buyer `0x3869…` → payTo-003, both service-owned) + the converge re-settles before the state-file fix (the wasteful part this run exposed and fixed). Failed settles cost nothing. Net ≈ facilitator fees + gas + the 2 refunded $0.002s.

## Cleared to continue
Indexing 100/100, zero regression, the 2 transient 504s refunded and now structurally prevented. The pipeline is hardened for repeated 100/day runs. Recommend the next batch use the same loop (now with state-file dedup) and continue rotating payTos.

## Artifacts
`author-batch-003.mjs`, `probe-batch.mjs`, `batch-003.json`, `manifest-batch-003.json`, `deploy-batch-003.sh`, `insert-batch-003.sql`, `index-batch.mjs` (state-file hardening), `verify-batch-003.mjs`, `wrap-batch.mjs` (grep + state fixes), `payto-pool.example.json` (addresses only, no keys).
