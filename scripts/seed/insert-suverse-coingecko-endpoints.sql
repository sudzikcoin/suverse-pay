-- Seed: five first-party CoinGecko-backed endpoints (no upstream
-- x402). Idempotent — re-runs are safe; UPSERT on
-- (resource_key_id, endpoint_slug). Same shape as the Helius batch.
--
-- Endpoints:
--   suverse-crypto-price-batch       ($0.005)  coingecko_price_batch
--   suverse-crypto-ohlc-history      ($0.02 )  coingecko_ohlc_history
--   suverse-crypto-market-rankings   ($0.01 )  coingecko_market_rankings
--   suverse-crypto-24h-movers        ($0.01 )  coingecko_24h_movers
--   suverse-crypto-trending          ($0.005)  coingecko_trending
--
-- All five:
--   * accept Base + Solana + Cosmos USDC (same merchant addresses as
--     the existing first-party rows);
--   * carry a catalog_listings row (status='approved') so CDP's
--     bazaar crawler picks them up;
--   * descriptions kept ASCII-only and trimmed to ≤ ~330 chars to
--     stay clear of the CDP /verify rejection trap documented in
--     the previous Helius batch.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. suverse-crypto-price-batch
-- ─────────────────────────────────────────────────────────────────────
WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, price_atomic,
    accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos,
    forward_auth_scheme,
    is_active, upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'suverse-crypto-price-batch',
    'suverse-crypto-price-batch',
    'https://proxy.suverse.io/v1/data/suverse-crypto-price-batch',
    'POST',
    'Batch Crypto Prices: Up to 50 Coins',
    'Current USD prices for up to 50 coin IDs in a single call. Returns price, 24h change, market cap, and trading volume per coin. Built for portfolio AI agents tracking watchlists, trading bots checking many assets at once, dashboards refreshing prices, and analytics tools doing comparative analysis. Covers 17,000+ tokens via CoinGecko.',
    5000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'coingecko_price_batch'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug      = EXCLUDED.public_slug,
        display_name     = EXCLUDED.display_name,
        description      = EXCLUDED.description,
        price_atomic     = EXCLUDED.price_atomic,
        accepted_networks= EXCLUDED.accepted_networks,
        pay_to_evm       = EXCLUDED.pay_to_evm,
        pay_to_solana    = EXCLUDED.pay_to_solana,
        pay_to_cosmos    = EXCLUDED.pay_to_cosmos,
        updated_at       = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url,
  tags, price_atomic_min, price_atomic_max, price_unit,
  networks, status, resource_key_id, slug,
  sample_request_json, sample_response_json,
  proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Batch Crypto Prices: Up to 50 Coins',
  'Current USD prices for up to 50 coin IDs in a single call. Returns price, 24h change, market cap, and trading volume per coin. Built for portfolio AI agents tracking watchlists, trading bots checking many assets at once, dashboards refreshing prices, and analytics tools doing comparative analysis. Covers 17,000+ tokens via CoinGecko.',
  'https://proxy.suverse.io/v1/data/suverse-crypto-price-batch',
  ARRAY['crypto','prices','batch','market-data','portfolio'],
  5000, 5000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-crypto-price-batch',
  '{"ids":["bitcoin","ethereum","solana"]}',
  '{"vs_currency":"usd","requested":3,"returned":3,"coins":[{"id":"bitcoin","symbol":"btc","name":"Bitcoin","current_price":65432.1,"market_cap":1290000000000,"total_volume":25000000000,"price_change_percentage_24h":1.23,"last_updated":"2026-06-01T05:00:00.000Z"}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 2. suverse-crypto-ohlc-history
-- ─────────────────────────────────────────────────────────────────────
WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, price_atomic,
    accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos,
    forward_auth_scheme,
    is_active, upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'suverse-crypto-ohlc-history',
    'suverse-crypto-ohlc-history',
    'https://proxy.suverse.io/v1/data/suverse-crypto-ohlc-history',
    'POST',
    'Crypto OHLC History: Daily Candles',
    'Daily OHLC (open/high/low/close) candle bars for any coin going back up to 365 days. Returns timestamp, open, high, low, close per day. Essential for AI agents running technical analysis, backtesting trading strategies, generating charts, computing volatility, and pattern recognition. Industry-standard format compatible with all charting libraries.',
    20000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'coingecko_ohlc_history'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug      = EXCLUDED.public_slug,
        display_name     = EXCLUDED.display_name,
        description      = EXCLUDED.description,
        price_atomic     = EXCLUDED.price_atomic,
        accepted_networks= EXCLUDED.accepted_networks,
        pay_to_evm       = EXCLUDED.pay_to_evm,
        pay_to_solana    = EXCLUDED.pay_to_solana,
        pay_to_cosmos    = EXCLUDED.pay_to_cosmos,
        updated_at       = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url,
  tags, price_atomic_min, price_atomic_max, price_unit,
  networks, status, resource_key_id, slug,
  sample_request_json, sample_response_json,
  proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Crypto OHLC History: Daily Candles',
  'Daily OHLC (open/high/low/close) candle bars for any coin going back up to 365 days. Returns timestamp, open, high, low, close per day. Essential for AI agents running technical analysis, backtesting trading strategies, generating charts, computing volatility, and pattern recognition. Industry-standard format compatible with all charting libraries.',
  'https://proxy.suverse.io/v1/data/suverse-crypto-ohlc-history',
  ARRAY['crypto','ohlc','history','candles','charts','technical-analysis'],
  20000, 20000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-crypto-ohlc-history',
  '{"coin_id":"bitcoin","days":7}',
  '{"coin_id":"bitcoin","days":7,"count":2,"candles":[{"timestamp":1780000000000,"date_iso":"2026-05-29T08:53:20.000Z","open":65000,"high":66500,"low":64800,"close":65900}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 3. suverse-crypto-market-rankings
-- ─────────────────────────────────────────────────────────────────────
WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, price_atomic,
    accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos,
    forward_auth_scheme,
    is_active, upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'suverse-crypto-market-rankings',
    'suverse-crypto-market-rankings',
    'https://proxy.suverse.io/v1/data/suverse-crypto-market-rankings',
    'POST',
    'Top Crypto by Market Cap with Full Metrics',
    'Top N cryptocurrencies ranked by market cap with comprehensive metrics: price, 24h volume, 1h/24h/7d/30d percentage changes, fully diluted valuation, circulating supply, ATH/ATL data, and market dominance. Built for AI agents creating leaderboards, screening opportunities, generating market reports, and tracking momentum. Customizable result count from 10 to 250.',
    10000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'coingecko_market_rankings'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug      = EXCLUDED.public_slug,
        display_name     = EXCLUDED.display_name,
        description      = EXCLUDED.description,
        price_atomic     = EXCLUDED.price_atomic,
        accepted_networks= EXCLUDED.accepted_networks,
        pay_to_evm       = EXCLUDED.pay_to_evm,
        pay_to_solana    = EXCLUDED.pay_to_solana,
        pay_to_cosmos    = EXCLUDED.pay_to_cosmos,
        updated_at       = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url,
  tags, price_atomic_min, price_atomic_max, price_unit,
  networks, status, resource_key_id, slug,
  sample_request_json, sample_response_json,
  proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Top Crypto by Market Cap with Full Metrics',
  'Top N cryptocurrencies ranked by market cap with comprehensive metrics: price, 24h volume, 1h/24h/7d/30d percentage changes, fully diluted valuation, circulating supply, ATH/ATL data, and market dominance. Built for AI agents creating leaderboards, screening opportunities, generating market reports, and tracking momentum. Customizable result count from 10 to 250.',
  'https://proxy.suverse.io/v1/data/suverse-crypto-market-rankings',
  ARRAY['crypto','rankings','market-cap','top-coins','leaderboard'],
  10000, 10000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-crypto-market-rankings',
  '{"limit":20}',
  '{"page":1,"limit":20,"count":20,"coins":[{"id":"bitcoin","symbol":"btc","name":"Bitcoin","current_price":65432,"market_cap":1290000000000,"market_cap_rank":1,"price_change_percentage_24h_in_currency":1.23,"price_change_percentage_7d_in_currency":4.5}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 4. suverse-crypto-24h-movers
-- ─────────────────────────────────────────────────────────────────────
WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, price_atomic,
    accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos,
    forward_auth_scheme,
    is_active, upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'suverse-crypto-24h-movers',
    'suverse-crypto-24h-movers',
    'https://proxy.suverse.io/v1/data/suverse-crypto-24h-movers',
    'POST',
    'Top Crypto Gainers and Losers in 24 Hours',
    'Top 10 biggest gainers and top 10 biggest losers in the last 24h by percentage change. Filtered by a minimum market cap floor to exclude pump-and-dump micro-caps and focus on meaningful market movers. Returns price, market cap, volume, and 24h change per coin. Critical for AI trading agents detecting momentum, news-driven moves, and sector rotations.',
    10000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'coingecko_24h_movers'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug      = EXCLUDED.public_slug,
        display_name     = EXCLUDED.display_name,
        description      = EXCLUDED.description,
        price_atomic     = EXCLUDED.price_atomic,
        accepted_networks= EXCLUDED.accepted_networks,
        pay_to_evm       = EXCLUDED.pay_to_evm,
        pay_to_solana    = EXCLUDED.pay_to_solana,
        pay_to_cosmos    = EXCLUDED.pay_to_cosmos,
        updated_at       = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url,
  tags, price_atomic_min, price_atomic_max, price_unit,
  networks, status, resource_key_id, slug,
  sample_request_json, sample_response_json,
  proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Top Crypto Gainers and Losers in 24 Hours',
  'Top 10 biggest gainers and top 10 biggest losers in the last 24h by percentage change. Filtered by a minimum market cap floor to exclude pump-and-dump micro-caps and focus on meaningful market movers. Returns price, market cap, volume, and 24h change per coin. Critical for AI trading agents detecting momentum, news-driven moves, and sector rotations.',
  'https://proxy.suverse.io/v1/data/suverse-crypto-24h-movers',
  ARRAY['crypto','movers','gainers','losers','momentum','trading'],
  10000, 10000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-crypto-24h-movers',
  '{}',
  '{"min_market_cap":10000000,"pool_size":210,"gainers":[{"id":"some-meme","symbol":"meme","name":"Meme","current_price":0.01,"market_cap":50000000,"total_volume":12000000,"price_change_percentage_24h":42.5}],"losers":[{"id":"some-loser","symbol":"lose","name":"Loser","current_price":0.5,"market_cap":80000000,"total_volume":3000000,"price_change_percentage_24h":-21.0}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 5. suverse-crypto-trending
-- ─────────────────────────────────────────────────────────────────────
WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, price_atomic,
    accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos,
    forward_auth_scheme,
    is_active, upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'suverse-crypto-trending',
    'suverse-crypto-trending',
    'https://proxy.suverse.io/v1/data/suverse-crypto-trending',
    'POST',
    'Trending Crypto Searches on CoinGecko',
    'Top 7 trending cryptocurrencies based on user searches on CoinGecko in the last 24 hours. Useful as a sentiment/hype signal showing which coins are capturing retail attention before price moves. Returns coin name, symbol, market cap rank, current price, and a thumbnail. Critical for AI agents detecting attention shifts, news discoveries, and meme coin emergence.',
    5000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'coingecko_trending'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug      = EXCLUDED.public_slug,
        display_name     = EXCLUDED.display_name,
        description      = EXCLUDED.description,
        price_atomic     = EXCLUDED.price_atomic,
        accepted_networks= EXCLUDED.accepted_networks,
        pay_to_evm       = EXCLUDED.pay_to_evm,
        pay_to_solana    = EXCLUDED.pay_to_solana,
        pay_to_cosmos    = EXCLUDED.pay_to_cosmos,
        updated_at       = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url,
  tags, price_atomic_min, price_atomic_max, price_unit,
  networks, status, resource_key_id, slug,
  sample_request_json, sample_response_json,
  proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Trending Crypto Searches on CoinGecko',
  'Top 7 trending cryptocurrencies based on user searches on CoinGecko in the last 24 hours. Useful as a sentiment/hype signal showing which coins are capturing retail attention before price moves. Returns coin name, symbol, market cap rank, current price, and a thumbnail. Critical for AI agents detecting attention shifts, news discoveries, and meme coin emergence.',
  'https://proxy.suverse.io/v1/data/suverse-crypto-trending',
  ARRAY['crypto','trending','sentiment','attention','discovery'],
  5000, 5000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-crypto-trending',
  '{}',
  '{"count":7,"coins":[{"id":"pepe","symbol":"PEPE","name":"Pepe","market_cap_rank":50,"thumb":"https://assets.coingecko.com/coins/images/29850/thumb/pepe.png","price_btc":0.00000000015,"score":0}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

COMMIT;
