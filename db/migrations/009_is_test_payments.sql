-- 009_is_test_payments.sql — Mainnet/testnet split for facilitator_payments.
--
-- Dashboard had been mixing real production settles with leftover
-- Phase 4 testnet rows (cosmos:grand-1, eip155:84532) and a handful
-- of synthetic mock-failure rows that point at the placeholder asset
-- `0x0` on Base mainnet. Aggregations (settles count, volume,
-- network breakdown) treated all of them as production.
--
-- Rather than DELETE we tag with an explicit boolean. Audit trail is
-- preserved (payment_attempts / facilitator_failover_events FK
-- against facilitator_payments.id) and any future replay of historic
-- traffic can still surface the data via an opt-in toggle.
--
-- Backfill rules (run at migration time, idempotent because the
-- column is created with default FALSE):
--   * network IN ('cosmos:grand-1', 'eip155:84532')                  → testnet
--   * network = 'eip155:8453' AND asset = '0x0'                      → synthetic mock
--
-- New rows default to is_test=FALSE; the facilitator write path will
-- override per-request in payments-log.ts so future testnet settles
-- self-classify (T1.1 in dashboard cleanup).

ALTER TABLE facilitator_payments
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE facilitator_payments
   SET is_test = TRUE
 WHERE is_test = FALSE
   AND (
        network IN ('cosmos:grand-1', 'eip155:84532')
     OR (network = 'eip155:8453' AND asset = '0x0')
   );

-- The dashboard's default queries filter on is_test=FALSE. A partial
-- index keeps the production read path narrow when test rows
-- accumulate from staging traffic.
CREATE INDEX IF NOT EXISTS facilitator_payments_mainnet_recent_idx
  ON facilitator_payments (created_at DESC)
  WHERE is_test = FALSE;
