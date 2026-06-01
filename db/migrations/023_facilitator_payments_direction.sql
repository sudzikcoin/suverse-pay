-- 023_facilitator_payments_direction.sql — tag facilitator_payments
-- rows with direction + kind so we can distinguish two flows that
-- share the table:
--
--   1. (existing, the only kind until now)
--      direction='inbound', kind='standard' — a buyer paid the
--      resource owner. payer = buyer, recipient = seller payTo.
--
--   2. (new, introduced by the upstream-x402 wrapping feature)
--      direction='outbound', kind='upstream-x402' — the proxy itself
--      acted as a buyer, signing a payment from a service wallet to a
--      402-protected upstream. payer = service wallet, recipient = the
--      upstream's payTo. resource_key_id is the proxy's own key (the
--      one that owns the seller_proxy_configs row that triggered the
--      outbound buy), so the seller's dashboard can join on it to show
--      "our cost" alongside "what the buyer paid".
--
-- Both columns default to the legacy semantics so existing rows
-- (and any settle code that hasn't been updated yet) keep working
-- without backfill. The new upstream-x402 logging path sets them
-- explicitly.

ALTER TABLE facilitator_payments
  ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'inbound',
  ADD COLUMN IF NOT EXISTS kind      TEXT NOT NULL DEFAULT 'standard';

CREATE INDEX IF NOT EXISTS facilitator_payments_outbound_idx
  ON facilitator_payments (resource_key_id, created_at DESC)
  WHERE direction = 'outbound';
