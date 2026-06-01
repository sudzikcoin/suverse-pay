-- 026_swap_transactions.sql — Solana swap orchestration ledger.
--
-- The SuVerse Swap feature lets an agent pay USDC via x402 and
-- receive a different SPL token (or SOL) in return, routed through
-- Jupiter aggregator. The flow is two-step:
--
--   1. POST /v1/swap/solana/quote — FREE. We query Jupiter, persist a
--      row with status='quoted', return quote_id + total_cost
--      (input + 1% service fee) + a 60s expiry.
--
--   2. POST /v1/swap/solana/execute/:quote_id — x402-paid. Buyer pays
--      total_cost in Solana USDC. We re-quote, sign the swap with the
--      dedicated liquidity wallet (SWAP_SOLANA_ADDRESS), broadcast,
--      transfer the output tokens to the buyer's payer address.
--
-- The status column drives the state machine; index lets a future
-- cron find stuck rows ('executing' for >5 min) and surface them.
--
-- pg-mem gotcha: pg-mem does not implement gen_random_uuid().
-- App-side inserts MUST supply UUIDs via Node crypto.randomUUID(),
-- same pattern as catalog_listings in 007. We omit the DEFAULT
-- so db tests don't break.
--
-- inbound_payment_id references facilitator_payments(id), which is
-- TEXT ("fpay_<ulid>") not UUID — match the existing column type.
-- ON DELETE SET NULL so deleting a payment row does not orphan a
-- swap_transactions row (we keep the swap record for audit).

CREATE TABLE IF NOT EXISTS swap_transactions (
  id                  UUID PRIMARY KEY,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  quote_id            TEXT NOT NULL UNIQUE,
  network             TEXT NOT NULL,
  input_token         TEXT NOT NULL,
  output_token        TEXT NOT NULL,
  input_amount        NUMERIC(30,0) NOT NULL,
  expected_output     NUMERIC(30,0),
  actual_output       NUMERIC(30,0),
  slippage_bps        INT,
  fee_amount          NUMERIC(30,0),
  recipient_address   TEXT,
  inbound_payment_id  TEXT REFERENCES facilitator_payments(id) ON DELETE SET NULL,
  swap_tx_hash        TEXT,
  status              TEXT NOT NULL DEFAULT 'quoted',
  error               TEXT,
  expires_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  -- Raw Jupiter quote response, used to re-submit the swap without
  -- another /quote round-trip. Stored JSONB for searchability.
  jupiter_quote       JSONB
);

CREATE INDEX IF NOT EXISTS swap_transactions_status_idx
  ON swap_transactions (status, created_at);

CREATE INDEX IF NOT EXISTS swap_transactions_recipient_idx
  ON swap_transactions (recipient_address);

-- Swap refunds — when execute fails AFTER payment is accepted, we
-- record an obligation here. v1: no automatic on-chain refund; a
-- human operator (or a future cron) drains pending rows.
CREATE TABLE IF NOT EXISTS swap_refunds (
  id                UUID PRIMARY KEY,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  swap_id           UUID NOT NULL REFERENCES swap_transactions(id) ON DELETE CASCADE,
  buyer_address     TEXT NOT NULL,
  network           TEXT NOT NULL,
  amount            NUMERIC(30,0) NOT NULL,
  reason            TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  refund_tx_hash    TEXT,
  refunded_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS swap_refunds_status_idx
  ON swap_refunds (status, created_at);

CREATE INDEX IF NOT EXISTS swap_refunds_swap_id_idx
  ON swap_refunds (swap_id);
