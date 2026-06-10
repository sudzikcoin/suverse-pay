-- Seed: crypto-market-pulse — ONE aggregated $0.10 endpoint that
-- internally combines five sources (fear-greed, coingecko-trending,
-- on-the-fly sm_trades netflow, BTC spot+24h delta, polymarket
-- smart-bias) into a single market-regime verdict. First product of
-- the "wrapper with derived value" class: the verdict exists in none
-- of the individual sources.
--
-- Handler: internal_handler='crypto_market_pulse' (apps/proxy
-- handlers/crypto-market-pulse.ts). Fail-closed: a registered
-- preflight proves fear-greed + netflow BEFORE settlement, so buyers
-- are never charged for an uncomputable verdict.
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
    'crypto-market-pulse', 'crypto-market-pulse',
    'https://proxy.suverse.io/v1/data/crypto-market-pulse',
    'POST',
    'Crypto Market Pulse',
    'One aggregated crypto market verdict from five live sources in a single paid call: fear and greed sentiment index, smart money netflow computed from tracked high-skill wallets on Solana and Base, CoinGecko trending coins cross-checked against smart money buying, BTC price with 24h change, and high-conviction Polymarket smart money positioning. Returns a market regime verdict (accumulation_on_fear, capitulation, confirmed_rally, late_stage_caution, mixed) with a plain-English summary, per-source signals, data quality block, and all raw source responses. Strictly more information than buying the five sources separately, for one payment.',
    'Aggregated crypto market verdict in one call: fear-greed sentiment crossed with smart-money netflow regime (accumulation_on_fear, capitulation, confirmed_rally, late_stage_caution), trending coins checked against smart-money buying, BTC 24h move, high-conviction Polymarket positioning, plus all raw source data.',
    100000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static', true, false,
    'crypto_market_pulse'
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
  'Crypto Market Pulse',
  'One aggregated crypto market verdict from five live sources in a single paid call: fear and greed sentiment index, smart money netflow computed from tracked high-skill wallets on Solana and Base, CoinGecko trending coins cross-checked against smart money buying, BTC price with 24h change, and high-conviction Polymarket smart money positioning. Returns a market regime verdict with plain-English summary, per-source signals, data quality block, and all raw source responses.',
  'https://proxy.suverse.io/v1/data/crypto-market-pulse',
  'market-sentiment',
  ARRAY['crypto','market-regime','sentiment','smart-money','netflow','trending','polymarket','aggregated','verdict'],
  100000, 100000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'crypto-market-pulse',
  '{}',
  '{"verdict":{"regime":"accumulation_on_fear","summary":"Market sentiment is Extreme Fear (9/100) and tracked smart-money wallets are net buyers over the last 24 hours, so smart money is accumulating into the fear, a historically contrarian-bullish setup. 2 of the top 7 trending coins have positive smart-money netflow behind the hype, and 1 Polymarket market shows high-conviction smart positioning.","confidence":"high"},"signals":{"sentiment":{"value":9,"classification":"Extreme Fear","bucket":"fear"},"smart_money":{"solana":{"sum_net_flow_usd_24h":4120.55,"sum_net_flow_usd_7d":11873.2,"pace_usd_per_hour_24h":171.69,"pace_usd_per_hour_7d":70.67,"direction":"inflow","eligible_tokens_24h":14,"eligible_tokens_7d":38,"regime":"accumulation_on_fear","coverage_level":"production"},"base":{"sum_net_flow_usd_24h":-23.65,"sum_net_flow_usd_7d":-78.2,"pace_usd_per_hour_24h":-0.99,"pace_usd_per_hour_7d":-0.47,"direction":"outflow","eligible_tokens_24h":1,"eligible_tokens_7d":4,"regime":"capitulation","coverage_level":"beta"}},"trending":[{"symbol":"HYPE","name":"Hyperliquid","market_cap_rank":11,"confirmed":true}],"btc":{"price_usd":62030,"change_24h_pct":-1.42,"source":"coingecko"},"polymarket":[{"market_id":"0xc4c3...","market_title":"Example market","category":"politics","conviction_score":67.47,"smart_side":"no","smart_yes_volume_usd":0,"smart_no_volume_usd":374.86}]},"data_quality":{"solana":"production","base":"beta","stale_sources":[],"computed_at":"2026-06-10T14:00:00.000Z"},"raw":{"fear_greed":{"current_value":9},"trending":{"count":15},"smart_money_netflow":{"solana":{}},"btc":{"bitcoin":{"usd":62030}},"polymarket":{"data":[]}}}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

COMMIT;
