-- 032_refund_retry_count.sql — refund worker retry bookkeeping.
--
-- The refund worker (apps/proxy/src/refund-worker.ts) processes
-- pending rows from swap_refunds + refunds_pending every 5 minutes.
-- A failed broadcast must be retried with a cap; this adds the
-- columns that bookkeeping needs:
--
--   retry_count   — incremented on every failed broadcast attempt.
--   last_retry_at — last attempt timestamp, for diagnostics.
--   last_error    — error message from the last failed broadcast.
--
-- At retry_count >= REFUND_WORKER_MAX_RETRIES (default 3) the worker
-- stops claiming the row and emits a JSON line to
-- /var/log/suverse-pay/refund-alerts.log. A human then either voids
-- the row or fixes the root cause and resets retry_count.
--
-- Partial pending indexes speed up the per-tick claim query:
--   SELECT ... WHERE status='pending' AND retry_count < N
--                ORDER BY created_at
--                FOR UPDATE SKIP LOCKED
--                LIMIT 1

ALTER TABLE swap_refunds
  ADD COLUMN IF NOT EXISTS retry_count   INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error    TEXT;

ALTER TABLE refunds_pending
  ADD COLUMN IF NOT EXISTS retry_count   INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error    TEXT;

CREATE INDEX IF NOT EXISTS swap_refunds_pending_pick_idx
  ON swap_refunds (created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS refunds_pending_pick_idx
  ON refunds_pending (created_at)
  WHERE status = 'pending';
