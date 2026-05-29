-- 004_per_settle_fees.sql — Phase 5 Block 4 Sub-task 3.
--
-- Per-settle platform fee accounting layer ("shadow ledger").
--
-- Adds:
--   * resource_api_keys.fee_bps        — per-key override in basis
--                                        points (NULL = use global
--                                        default from PLATFORM_FEE_BPS
--                                        env). Bounded 0..1000 (0..10%).
--   * facilitator_payments.gross_amount, fee_amount, net_amount
--                                      — accounting overlay on the
--                                        existing `amount` column. The
--                                        invariant is
--                                        `gross_amount = fee_amount + net_amount`.
--                                        `amount` keeps its meaning of
--                                        "what was settled on-chain"
--                                        (= gross for now — suverse-pay
--                                        does not yet collect the fee
--                                        on-chain; collection is
--                                        out-of-band via invoice CSV
--                                        download from the dashboard).
--
-- Backfill semantics: every pre-existing facilitator_payments row
-- becomes (gross=amount, fee=0, net=amount). This is honest — those
-- settles were not fee'd, the customer was not charged. From this
-- migration forward, every new row is computed via the same path.


-- ---------------------------------------------------------------
-- resource_api_keys.fee_bps
-- ---------------------------------------------------------------

ALTER TABLE resource_api_keys
  ADD COLUMN IF NOT EXISTS fee_bps INTEGER;

-- Named CHECK so future migrations / introspection have a stable
-- handle. The migration runner records this file in
-- schema_migrations and will not re-apply it, so plain ADD
-- CONSTRAINT is safe (no need for plpgsql IF NOT EXISTS — pg-mem
-- in tests does not register the plpgsql language).
ALTER TABLE resource_api_keys
  ADD CONSTRAINT resource_api_keys_fee_bps_range
  CHECK (fee_bps IS NULL OR (fee_bps >= 0 AND fee_bps <= 1000));


-- ---------------------------------------------------------------
-- facilitator_payments — gross/fee/net columns
-- ---------------------------------------------------------------

ALTER TABLE facilitator_payments
  ADD COLUMN IF NOT EXISTS gross_amount NUMERIC(78, 0);
ALTER TABLE facilitator_payments
  ADD COLUMN IF NOT EXISTS fee_amount   NUMERIC(78, 0);
ALTER TABLE facilitator_payments
  ADD COLUMN IF NOT EXISTS net_amount   NUMERIC(78, 0);

-- Backfill — existing settles did not have a fee deducted.
-- `amount` is TEXT (carries the atomic uint256 as a string to avoid
-- precision loss), so cast explicitly to numeric for the assignment.
UPDATE facilitator_payments
   SET gross_amount = amount::numeric,
       fee_amount   = 0,
       net_amount   = amount::numeric
 WHERE gross_amount IS NULL;

-- Now that every row has values, pin NOT NULL so the application
-- writer must always supply them going forward.
ALTER TABLE facilitator_payments
  ALTER COLUMN gross_amount SET NOT NULL,
  ALTER COLUMN fee_amount   SET NOT NULL,
  ALTER COLUMN net_amount   SET NOT NULL;

-- Invariant guard. Cheap CHECK — the planner skips it on read, and
-- the writer-side computeFee() helper is the authoritative source of
-- the split. The CHECK catches a future direct UPDATE that
-- accidentally desyncs the three columns.
ALTER TABLE facilitator_payments
  ADD CONSTRAINT facilitator_payments_fee_split_balanced
  CHECK (gross_amount = fee_amount + net_amount);
