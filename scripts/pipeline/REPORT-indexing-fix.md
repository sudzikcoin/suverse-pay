# CDP Bazaar Auto-Indexing Fix + Backfill + payTo Cap Investigation

**Date:** 2026-06-19 · **Repo:** suverse-pay · **Commit:** `56cbb2e`

## TL;DR
- **Pipeline fixed** so every wrapped endpoint auto-fires one CDP indexing settle (per-endpoint, not per-batch sample). Durable for all future batches.
- **Backfill:** of 74 wrapped endpoints (batch-001 + batch-002), only **14 were indexed**; all 60 unindexed got an indexing settle. **14/74 → 74/74 indexed** — all 74 confirmed in CDP merchant (after CDP latency resolved).
- **payTo "47 cap" is NOT real.** Direct evidence: **133 endpoints index under a single payTo**. What looked like a cap was CDP indexing *latency* (eventually-consistent, multi-minute, bursty). payTo rotation was still built as a forward scaling safeguard and proven to work.
- **E2E proven:** a brand-new endpoint pushed through the fixed pipeline auto-settled and appeared in CDP within ~90s.

---

## 1. Root cause (why ~60 endpoints were dark)
Two compounding bugs, not one:
1. **Sample-only settling.** The pipeline settled a handful of slugs per batch for the live-settle proof; CDP only indexes an endpoint *after* a Base settle hits it, so the un-sampled endpoints were never woken.
2. **The preflight blocks empty-body wakes.** The old `republish-bazaar-all.mts` indexing-wake POSTs `{}`. But the declarative preflight (added in batch-001/002) *rejects* empty bodies before settlement — so a `{}` wake on a required-field endpoint **never settles**, hence never indexes. The fix must settle with each endpoint's **valid `sampleRequest`** (which the manifest already carries).

## 2. The fix (durable, per-endpoint)
**`apps/proxy/scripts/index-batch.mjs`** — the new mandatory indexing stage:
- Fires exactly **one Base settle per endpoint** — every slug in the manifest, never a sample — using its **valid `sampleRequest`** so the preflight passes.
- **Idempotent**: reads the CDP merchant feed for the target payTo up front and skips already-indexed slugs. Safe to re-run; re-runs converge (each pass clears transient failures).
- **Paced** (`--delay`, default 2.5s) to dodge CDP-facilitator burst-rate `502`s, with `--poll` to confirm indexing.

**`scripts/pipeline/wrap-batch.mjs`** now:
- Reads `activePayTo` from the rotation pool registry (so each batch lands on the live merchant address).
- Emits **`deploy-<batch>.sh`** that bakes the whole tail: dry-run seed → apply → restart proxy → **`index-batch --batch <id> --delay 3000 --poll`**. The per-endpoint indexing settle is now an unconditional pipeline stage — a batch can no longer land live-but-invisible.

New canonical loop: **author → probe → wrap-batch → `bash deploy-<batch>.sh`** (seed + restart + auto-index every endpoint).

## 3. payTo cap — investigated, disproven
The suspected ~47-per-payTo cap is **not real**, established with direct measurement against CDP `/discovery/merchant?payTo=…` (`pagination.total`):

| Observation | Evidence |
|---|---|
| Single payTo holds **133** indexed resources | `merchant total` for `0x260fbe…` grew 93 → **133** during backfill |
| Endpoints past 47/93 index fine | the 84th–133rd all appear |
| "Stuck at 93" was **latency, not a cap** | after a 90s snapshot showed 93, the same feed later read 133 with no new action; a fresh payTo went 0→2 in 15s then 2→10→17 over minutes |

**What actually bit us:** (a) CDP indexing is eventually-consistent with **multi-minute, bursty latency** (snapshots mislead), and (b) the CDP **facilitator returns transient `502`/`facilitator_error` under sustained settle load** (~50% during a 60-settle burst; buyer was never charged on those — `settle_failed`, no tx). Both are handled by the paced, idempotent, re-runnable indexer.

## 4. payTo rotation (built as a scaling safeguard)
Even without a proven cap, 100/day will pile thousands onto one payTo and we won't assume an infinite ceiling. So:
- **`apps/proxy/scripts/mint-payto.mjs`** — generates a fresh EVM service payTo, writes the key to `/etc/suverse-pay/payto-<NNN>.key` **chmod 600** (never in-repo, never key-in-memory-only), registers it in `/etc/suverse-pay/payto-pool.json` and sets it active.
- Minted **`0x2d50131399DDb89de63eEe353EeDa2c7AB97DFBA`** (key at `/etc/suverse-pay/payto-002.key`, 600). `wrap-batch` now reads `activePayTo` from the pool; future batches rotate. Soft cap 80 (well under the observed-working 133).
- **Re-home proof:** the unindexed endpoints were re-homed onto the fresh payTo and indexed there — proving rotation + re-home works end to end (new payTo total climbed 0 → 17). No endpoints were "stuck above a cap" (there is no cap), so no forced re-home was required; the re-home doubled as the cap test.

## 5. Verification (no self-reported success)
- **Merchant counts (before → after):** old payTo `0x260fbe…` **93 → 133**; new payTo `0x2d50…` **0 → 17**. Our-74 indexed **14 → 74/74** (all confirmed in CDP merchant).
- **3 backfilled slugs proven queryable in CDP `/discovery/merchant`:**
  - `suverse-treasury-avg-rates` → `https://proxy.suverse.io/v1/data/suverse-treasury-avg-rates` (amount 5000)
  - `suverse-quakes-recent` → `…/suverse-quakes-recent` (amount 3000)
  - `suverse-openfda-drug-label` → `…/suverse-openfda-drug-label` (amount 4000)
- **Buyer-facing discovery:** `/discovery/search?query=treasury%20yields` returns `suverse-treasury-avg-rates` → agent-discoverable, not just in the merchant mirror.
- **E2E auto-index:** `suverse-e2e-worldbank-population` created via the fixed pipeline (wrap-batch used the new pool payTo → `deploy-batch-e2e.sh` → auto-settle tx `0x14d7b106…`) appeared in CDP merchant under the new payTo within ~90s.
- **Gate:** `pnpm build` 25/25 green; 14 declarative-engine unit tests green.

## 6. Honest caveats / follow-ups
- **CDP indexing latency is variable** (15s to several minutes, bursty). The `--poll` window can expire before a settle indexes — that's a *display* lag, not a failure; the settle is on-chain and indexes shortly. Re-run `index-batch` (idempotent) to reconfirm; it skips already-indexed and only retries laggards.
- **Facilitator transient 502s.** Under sustained load CDP `/settle` intermittently fails (`facilitator_error`, no charge). The idempotent indexer converges across re-runs; for 100/day, keep `--delay >= 3s` and expect 1–2 reconfirm passes. A small handful (`mlb-schedule`, `fx-historical-date`, `timezones-list`, `openfda-device-recalls`) needed 2–3 paced retries — all eventually settled.
- **Endpoints are now split across two payTos** (most on `0x260fbe…`, the re-homed/backfilled set on `0x2d50…`). Both are service-owned and both index; this is benign and validates rotation. Future batches use the active pool payTo.
- **Spend:** backfill + retries + E2E ran ~115 self-settles, principal cycling between two service wallets; net cost ≈ facilitator fees + gas. Buyer wallet `0x3869…` healthy.

## Artifacts in this bundle
`index-batch.mjs`, `mint-payto.mjs`, `wrap-batch.mjs` (rotation + deploy emit), `deploy-batch-e2e.sh`, `batch-e2e.json`, `manifest-batch-e2e.json`, `insert-batch-e2e.sql`, and a sanitized `payto-pool.example.json` (addresses only — no keys).
