-- 015_mpp_protocol.sql — second protocol family in the payments
-- ledger (Phase 5 Phase 2 T7).
--
-- The `payments` table was created Phase 1 with x402 as its only
-- protocol. As of Phase 5 Phase 2 the gateway also handles MPP
-- (Stripe / Tempo's 402-sibling protocol; see
-- packages/adapters/mpp/README.md). MPP rows need to be identified
-- separately so /payments queries can filter by protocol and the
-- dashboard can render method/intent metadata.
--
-- Adds:
--   * `protocol` — "x402" | "mpp". NOT NULL, defaults to "x402" so
--     all existing rows backfill cleanly without an UPDATE. New
--     /facilitator/settle writes keep emitting the default; new
--     /mpp/charge writes (T8) emit "mpp" explicitly.
--   * `mpp_method` — the MPP method (e.g. "tempo"). NULL for x402.
--   * `mpp_intent` — the MPP intent (e.g. "charge"). NULL for x402.
--   * Partial index on `(mpp_method, mpp_intent)` for the MPP-row
--     filter path. Tiny — only MPP rows are indexed.
--
-- Invariant — (protocol='mpp') IS (mpp_method AND mpp_intent set) —
-- is enforced application-side in services/orchestrator/src/ledger.ts.
-- A DB-level CHECK across multiple columns is intentionally NOT added
-- here: pg-mem (used for the migration golden test) supports inline
-- column-level CHECKs but trips on cross-column table-level ADD
-- CONSTRAINTs, and the cost of weakening the migrate-test surface
-- isn't worth the marginal extra guard.
--
-- Backfill: no UPDATE needed — every existing row IS an x402 payment
-- by construction, and the default takes care of the new column.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS protocol   TEXT NOT NULL DEFAULT 'x402',
  ADD COLUMN IF NOT EXISTS mpp_method TEXT,
  ADD COLUMN IF NOT EXISTS mpp_intent TEXT;

CREATE INDEX IF NOT EXISTS payments_by_mpp_idx
  ON payments (mpp_method, mpp_intent)
  WHERE protocol = 'mpp';
