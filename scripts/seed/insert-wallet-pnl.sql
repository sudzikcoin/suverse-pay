-- wallet-pnl — in-house single-wallet PnL + skill snapshot from sm_wallets.
-- Idempotent UPSERT. Reuses reskey reskey_1166628d + payto-005 trio.
-- Price $0.05 (floor; single-row lookup, not compute-heavy) per the pricing rule.
BEGIN;

WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug, original_url, original_method,
    display_name, description, description_bazaar, price_atomic, accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos, forward_auth_scheme, is_active,
    upstream_x402_enabled, internal_handler
  ) VALUES (
    gen_random_uuid(), 'reskey_1166628d', 'wallet-pnl', 'wallet-pnl',
    'https://proxy.suverse.io/v1/data/wallet-pnl', 'POST',
    'Wallet PnL & Skill Snapshot',
    'Profit-and-loss and skill snapshot for a single tracked wallet, read from our own smart-money scoring table: 90d PnL, realized PnL, win rate, profit factor, max drawdown, median return per trade, trade cadence (buys/sells/early entries/holding time) and the derived skill score + tier. Accepts an EVM (0x) or Solana base58 address; chain auto-detected. An untracked wallet returns a clean tracked:false verdict, not an error.',
    'One-call PnL + skill verdict for any tracked wallet (EVM or Solana): 90d realized/total PnL, win rate, profit factor, drawdown, trade cadence, skill score + tier. Untracked wallets return tracked:false (not an error). Sourced from our own smart-money scoring table.',
    50000, ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0xe90316121189715CDc2515B7C2673658b810b751', 'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM', 'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj', 'static', true,
    false, 'wallet_pnl'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler, public_slug = EXCLUDED.public_slug,
        display_name = EXCLUDED.display_name, description = EXCLUDED.description,
        description_bazaar = EXCLUDED.description_bazaar, price_atomic = EXCLUDED.price_atomic,
        accepted_networks = EXCLUDED.accepted_networks, pay_to_evm = EXCLUDED.pay_to_evm,
        pay_to_solana = EXCLUDED.pay_to_solana, pay_to_cosmos = EXCLUDED.pay_to_cosmos,
        is_active = true, updated_at = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url, category, tags,
  price_atomic_min, price_atomic_max, price_unit, networks, status,
  resource_key_id, slug, sample_request_json, sample_response_json,
  description_bazaar, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Wallet PnL & Skill Snapshot',
  'Profit-and-loss + skill snapshot for one tracked wallet from our own smart-money scoring table: 90d PnL, realized PnL, win rate, profit factor, drawdown, trade cadence and skill score/tier. EVM or Solana; untracked wallets return tracked:false.',
  'https://proxy.suverse.io/v1/data/wallet-pnl',
  'wallet-analytics',
  ARRAY['wallet','pnl','smart-money','trader-skill','win-rate','profit-factor','verdict','solana','base'],
  50000, 50000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved',
  proxy_ins.resource_key_id, 'wallet-pnl',
  '{"address":"8psNvWTrdNTiVRNzAgsou9kETXNJm2SXZyaKuJraVRtf"}',
  '{"address":"8psNvWTrdNTiVRNzAgsou9kETXNJm2SXZyaKuJraVRtf","chain":"solana","tracked":true,"verdict":{"profitability":"profitable","summary":"...","confidence":"high"},"signals":{"pnl":{"pnl_90d_usd":0,"realized_pnl_usd":0,"win_rate":0,"profit_factor":0},"activity":{"trade_count_90d":0},"skill":{"score":0,"tier":"elite"}},"data_quality":{"tracking_coverage":"tracked","stale":false}}',
  'One-call PnL + skill verdict for any tracked wallet (EVM or Solana): 90d realized/total PnL, win rate, profit factor, drawdown, trade cadence, skill score + tier. Untracked wallets return tracked:false. Sourced from our own smart-money scoring table.',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

COMMIT;
