-- 027_refunds_pending.sql — track buyer payments that need refund
-- because the upstream we proxy to failed AFTER the buyer paid us.
--
-- Background: when a proxy config has upstream_x402_enabled=true, the
-- proxy first takes the buyer's payment (recorded inbound via
-- facilitator_payments), then pays an upstream x402 service from its
-- own wallet. If the upstream returns a post-payment 500 / times out /
-- network-errors out, our service wallet has spent on-chain but the
-- buyer never gets the response data they paid for. The clean fix is
-- to refund the buyer's inbound payment.
--
-- Refunds are an out-of-band operator action (separate signer, separate
-- approvals) — this table is the durable queue the operator drains.
-- The proxy's request path only inserts; refund execution lives in a
-- separate worker / dashboard action (not part of this migration).
--
-- pg-mem gotcha: pg-mem does not implement gen_random_uuid().
-- App-side inserts MUST supply UUIDs via Node crypto.randomUUID(),
-- same pattern as catalog_listings (007) and swap_transactions (026).
-- We omit the DEFAULT so db tests don't break.

CREATE TABLE IF NOT EXISTS refunds_pending (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT NOW(),

  -- Which proxy endpoint took the inbound payment that needs refunding.
  proxy_config_id uuid NOT NULL
    REFERENCES seller_proxy_configs(id) ON DELETE CASCADE,
  resource_key_id text NOT NULL
    REFERENCES resource_api_keys(id) ON DELETE CASCADE,

  -- Buyer payment details (denormalized — receipt from x402-server, so
  -- a refund processor doesn't have to rejoin against the eventually-
  -- consistent facilitator_payments row).
  buyer_address text NOT NULL,
  buyer_network text NOT NULL,            -- CAIP-2
  buyer_asset text NOT NULL,              -- token contract / mint
  buyer_amount_atomic numeric(78, 0) NOT NULL,
  buyer_tx_hash text,                     -- inbound on-chain proof; may be NULL

  -- Why we're refunding.
  reason text NOT NULL,                   -- 'upstream_post_payment_500', 'upstream_post_payment_timeout', 'upstream_post_payment_network'
  upstream_status integer,                -- HTTP status from the failing upstream call
  upstream_error_snippet text,            -- first 500 chars of upstream body, for triage

  -- Refund execution state. The operator processes 'pending' rows and
  -- flips to 'refunded' once the on-chain return is broadcast, or
  -- 'voided' if the row turns out to be a duplicate / not refundable.
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'refunded', 'voided')),
  refund_tx_hash text,
  refunded_at timestamptz,

  -- Link back to the facilitator_payments row that took the inbound
  -- payment (when available). NULL when refund was recorded faster
  -- than the inbound link landed; the (buyer_tx_hash, buyer_network)
  -- tuple is the canonical join key in that case.
  inbound_facilitator_payment_id text
    REFERENCES facilitator_payments(id) ON DELETE SET NULL
);

CREATE INDEX refunds_pending_status_idx
  ON refunds_pending(status, created_at);

CREATE INDEX refunds_pending_buyer_idx
  ON refunds_pending(buyer_address, status);

CREATE INDEX refunds_pending_proxy_config_idx
  ON refunds_pending(proxy_config_id, created_at DESC);

-- Same (buyer_tx_hash, proxy_config_id) appearing twice would mean we
-- double-recorded a failed upstream call. Treat as a bug — the unique
-- index forces the bookkeeping path to be idempotent. NULL tx_hash is
-- allowed (some facilitators don't surface one); those rows skip the
-- uniqueness guarantee, accepted tradeoff for the rare case.
CREATE UNIQUE INDEX refunds_pending_dedupe_idx
  ON refunds_pending(proxy_config_id, buyer_tx_hash)
  WHERE buyer_tx_hash IS NOT NULL;
