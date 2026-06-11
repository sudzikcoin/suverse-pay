-- Seed: token-check — ONE aggregated $0.05 endpoint answering "what's
-- the state of this Solana token — is it sane to enter?" from six
-- sources: our elite smart-money flow (sm_trades x sm_wallets), Jupiter
-- tokens/v2 (age, holders, audit, momentum), a real $500 Jupiter quote
-- (exit cost; "no route" is a first-class untradeable verdict), Helius
-- RPC holder concentration with pool exclusion (degrades to Jupiter
-- audit on BONK-class tokens), Helius getAsset metadata cross-check,
-- and DexScreener pair enrichment.
--
-- Handler: internal_handler='token_check' (apps/proxy
-- handlers/token-check.ts). Fail-closed: a registered preflight proves
-- the DB elite queries + both Jupiter calls BEFORE settlement, so
-- buyers are never charged for an uncomputable verdict. A base58
-- validator rejects garbage mints with 422 before the 402 challenge.
--
-- Idempotent — re-runs safe via UPSERT. Descriptions ASCII-only.

BEGIN;

WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, description_bazaar, price_atomic,
    accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos,
    forward_auth_scheme, is_active, upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'token-check', 'token-check',
    'https://proxy.suverse.io/v1/data/token-check',
    'POST',
    'Solana Token Check',
    'One aggregated safety verdict for any Solana token mint in a single paid call: overall risk level (low, moderate, high, critical) with explicit flags, exit cost measured by a real 500 USD Jupiter quote (price impact buckets deep, adequate, thin, exit_trap, untradeable), top-10 holder concentration with AMM pool and PDA supply excluded so bonding-curve tokens are not false alarms, token age from first pool creation, mint and freeze authority checks, dev mint history, 24h momentum from price, holder and volume changes, and a premium elite smart-money layer showing whether our highest-scoring tracked wallets bought or sold this token in the last 30 days and when they exited. Answers: what is the state of this token and is it sane to enter? Returns verdict, per-source signals, data quality block, and raw source data.',
    'Solana token safety verdict in one call: risk level with flags, exit cost from a real $500 quote, top-10 holder concentration with pools excluded, token age, mint and freeze authority checks, 24h momentum, and whether elite smart-money wallets bought or sold it in the last 30 days. Answers: is this token sane to enter?',
    50000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static', true, false,
    'token_check'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug = EXCLUDED.public_slug, display_name = EXCLUDED.display_name,
        description = EXCLUDED.description,
        description_bazaar = EXCLUDED.description_bazaar,
        price_atomic = EXCLUDED.price_atomic,
        accepted_networks = EXCLUDED.accepted_networks,
        pay_to_evm = EXCLUDED.pay_to_evm, pay_to_solana = EXCLUDED.pay_to_solana,
        pay_to_cosmos = EXCLUDED.pay_to_cosmos, updated_at = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url, category, tags,
  price_atomic_min, price_atomic_max, price_unit, networks, status,
  resource_key_id, slug, sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Solana Token Check',
  'One aggregated safety verdict for any Solana token mint in a single paid call: overall risk level with explicit flags, exit cost measured by a real 500 USD Jupiter quote, top-10 holder concentration with AMM pool supply excluded, token age, mint and freeze authority checks, 24h momentum, and a premium elite smart-money layer showing whether our highest-scoring tracked wallets bought or sold this token in the last 30 days. Answers: is this token sane to enter?',
  'https://proxy.suverse.io/v1/data/token-check',
  'smart-money',
  ARRAY['solana','token','risk','rug-check','safety','smart-money','liquidity','aggregated','verdict'],
  50000, 50000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'token-check',
  '{"token":"DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"}',
  '{"token":"DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263","verdict":{"risk_level":"low","flags":[],"summary":"Overall risk is low for Bonk: liquidity is deep (0.04% impact on a $500 buy), top-10 wallet-held supply is distributed at 12.1%, the token is established. None of our elite smart-money wallets touched this token in the last 30 days.","confidence":"high"},"signals":{"liquidity":{"bucket":"deep","price_impact_pct_500_usd":0.044,"no_route":false,"quote_error_code":null},"concentration":{"bucket":"distributed","wallet_held_top10_pct":12.1,"pool_held_top10_pct":31.4,"source":"rpc","holders":[{"token_account":"9AhKqLR6...","owner":"5Q544fKr...","kind":"pool","share_pct":9.7}]},"age":{"bucket":"established","first_pool_created_at":"2023-05-11T17:09:10.000Z"},"authority":{"mint_authority_disabled":true,"freeze_authority_disabled":true,"dev_mints":0},"momentum":{"label":"flat","price_change_24h_pct":1.2,"holder_change_24h_pct":0.3,"buy_volume_24h_usd":1250000,"sell_volume_24h_usd":1190000,"organic_score":82.5,"organic_score_label":"high"},"elite_flow":{"status":"no_elite_interest","card":null,"elite_feed_lag_hours":12.5}},"data_quality":{"stale_sources":[],"concentration_source":"rpc","computed_at":"2026-06-11T12:00:00.000Z"},"raw":{"elite_flow":{"buy_usd":0,"sell_usd":0,"net_usd":0,"distinct_elite_wallets":0,"trade_legs":0},"jupiter_token":{"symbol":"Bonk","holderCount":1006288},"jupiter_quote":{"priceImpactPct":"0.00044"},"holders":{"supply_atomic":88994725323138}}}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

COMMIT;
