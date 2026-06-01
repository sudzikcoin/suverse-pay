-- Seed: ten first-party endpoints across TA (3 from Binance klines
-- + local math), perp derivatives (2 from Binance futures), DeFi
-- stablecoins (1 from DeFiLlama), US stocks (2 from Yahoo Finance),
-- and forex (2 from Frankfurter / ECB). Idempotent — re-runs safe
-- via UPSERT.
--
-- Same merchant addresses + resource_key as the prior 20+ rows.
-- Descriptions ASCII-only, 335-365 chars, no em-dash (CDP /verify
-- trap #6 per reference-cdp-bazaar-indexing).

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. suverse-ta-rsi  ($0.01)
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
    'suverse-ta-rsi',
    'suverse-ta-rsi',
    'https://proxy.suverse.io/v1/data/suverse-ta-rsi',
    'POST',
    'RSI Indicator on Any Pair',
    'Wilder RSI 14 for any Binance spot pair on any timeframe from 1 minute to 1 week. Returns the current RSI value, overbought above 70 or oversold below 30 signal, trend direction, and the last 50 historical RSI points for chart rendering. Critical for AI trading bots detecting momentum reversals, swing traders identifying entry zones.',
    10000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'ta_rsi'
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
  sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'RSI Indicator on Any Pair',
  'Wilder RSI 14 for any Binance spot pair on any timeframe from 1 minute to 1 week. Returns the current RSI value, overbought above 70 or oversold below 30 signal, trend direction, and the last 50 historical RSI points for chart rendering. Critical for AI trading bots detecting momentum reversals, swing traders identifying entry zones.',
  'https://proxy.suverse.io/v1/data/suverse-ta-rsi',
  ARRAY['crypto','rsi','technical-analysis','indicator','momentum'],
  10000, 10000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-ta-rsi',
  '{"symbol":"BTCUSDT","interval":"1h"}',
  '{"symbol":"BTCUSDT","interval":"1h","period":14,"start_index":14,"current_rsi":58.4,"signal":"neutral","trend":"rising","historical":[{"time":1780000000000,"value":52.1},{"time":1780003600000,"value":54.7}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 2. suverse-ta-macd  ($0.01)
-- ─────────────────────────────────────────────────────────────────────
WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, price_atomic,
    accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos,
    forward_auth_scheme, is_active, upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'suverse-ta-macd', 'suverse-ta-macd',
    'https://proxy.suverse.io/v1/data/suverse-ta-macd',
    'POST',
    'MACD Signal Indicator',
    'MACD 12 26 9 with signal line and histogram on any Binance spot pair and timeframe. Returns current MACD value, signal line, histogram, bullish or bearish crossover detection within the last 5 periods, and trend strength. Essential for AI trading agents identifying trend changes, momentum confirmation, and divergence detection.',
    10000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static', true, false,
    'ta_macd'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug = EXCLUDED.public_slug, display_name = EXCLUDED.display_name,
        description = EXCLUDED.description, price_atomic = EXCLUDED.price_atomic,
        accepted_networks = EXCLUDED.accepted_networks,
        pay_to_evm = EXCLUDED.pay_to_evm, pay_to_solana = EXCLUDED.pay_to_solana,
        pay_to_cosmos = EXCLUDED.pay_to_cosmos, updated_at = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url, tags,
  price_atomic_min, price_atomic_max, price_unit, networks, status,
  resource_key_id, slug, sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'MACD Signal Indicator',
  'MACD 12 26 9 with signal line and histogram on any Binance spot pair and timeframe. Returns current MACD value, signal line, histogram, bullish or bearish crossover detection within the last 5 periods, and trend strength. Essential for AI trading agents identifying trend changes, momentum confirmation, and divergence detection.',
  'https://proxy.suverse.io/v1/data/suverse-ta-macd',
  ARRAY['crypto','macd','technical-analysis','indicator','crossover'],
  10000, 10000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-ta-macd',
  '{"symbol":"BTCUSDT","interval":"1h"}',
  '{"symbol":"BTCUSDT","interval":"1h","fast":12,"slow":26,"signal_period":9,"current_macd":15.4,"current_signal":12.1,"current_histogram":3.3,"cross":{"direction":"bullish","periodsAgo":2},"trend":"uptrend","histogram_last_10":[2.1,2.4,2.8,3.0,3.1,3.2,3.0,3.1,3.2,3.3]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 3. suverse-ta-moving-averages  ($0.01)
-- ─────────────────────────────────────────────────────────────────────
WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, price_atomic,
    accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos,
    forward_auth_scheme, is_active, upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'suverse-ta-moving-averages', 'suverse-ta-moving-averages',
    'https://proxy.suverse.io/v1/data/suverse-ta-moving-averages',
    'POST',
    'Moving Averages 20 50 200 with Cross Signals',
    'SMA and EMA at 20, 50, and 200 periods for any Binance pair on any timeframe. Returns current price, all six averages, golden cross or death cross detection within last 10 periods, and trend classification above or below the 200 SMA. Critical for AI agents implementing classic trend following strategies and dynamic support resistance levels.',
    10000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static', true, false,
    'ta_moving_averages'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug = EXCLUDED.public_slug, display_name = EXCLUDED.display_name,
        description = EXCLUDED.description, price_atomic = EXCLUDED.price_atomic,
        accepted_networks = EXCLUDED.accepted_networks,
        pay_to_evm = EXCLUDED.pay_to_evm, pay_to_solana = EXCLUDED.pay_to_solana,
        pay_to_cosmos = EXCLUDED.pay_to_cosmos, updated_at = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url, tags,
  price_atomic_min, price_atomic_max, price_unit, networks, status,
  resource_key_id, slug, sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Moving Averages 20 50 200 with Cross Signals',
  'SMA and EMA at 20, 50, and 200 periods for any Binance pair on any timeframe. Returns current price, all six averages, golden cross or death cross detection within last 10 periods, and trend classification above or below the 200 SMA. Critical for AI agents implementing classic trend following strategies and dynamic support resistance levels.',
  'https://proxy.suverse.io/v1/data/suverse-ta-moving-averages',
  ARRAY['crypto','moving-averages','technical-analysis','sma','ema','golden-cross'],
  10000, 10000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-ta-moving-averages',
  '{"symbol":"BTCUSDT","interval":"1d"}',
  '{"symbol":"BTCUSDT","interval":"1d","current_price":65432.10,"sma_20":63450,"sma_50":61000,"sma_200":55000,"ema_20":64210,"ema_50":62100,"ema_200":56800,"cross":{"type":"golden_cross","periods_ago":4},"trend":"above_200sma"}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 4. suverse-perp-open-interest  ($0.01)
-- ─────────────────────────────────────────────────────────────────────
WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, price_atomic,
    accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos,
    forward_auth_scheme, is_active, upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'suverse-perp-open-interest', 'suverse-perp-open-interest',
    'https://proxy.suverse.io/v1/data/suverse-perp-open-interest',
    'POST',
    'Perpetual Open Interest Snapshot',
    'Current open interest for any Binance perpetual contract with 24 hour change percentage, notional value in USD, and historical OI over the last 24 hours at 5 minute intervals. Critical for AI agents detecting leverage buildups, identifying squeeze setups, monitoring funding pressure precursors, and quantifying market positioning.',
    10000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static', true, false,
    'binance_open_interest'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug = EXCLUDED.public_slug, display_name = EXCLUDED.display_name,
        description = EXCLUDED.description, price_atomic = EXCLUDED.price_atomic,
        accepted_networks = EXCLUDED.accepted_networks,
        pay_to_evm = EXCLUDED.pay_to_evm, pay_to_solana = EXCLUDED.pay_to_solana,
        pay_to_cosmos = EXCLUDED.pay_to_cosmos, updated_at = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url, tags,
  price_atomic_min, price_atomic_max, price_unit, networks, status,
  resource_key_id, slug, sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Perpetual Open Interest Snapshot',
  'Current open interest for any Binance perpetual contract with 24 hour change percentage, notional value in USD, and historical OI over the last 24 hours at 5 minute intervals. Critical for AI agents detecting leverage buildups, identifying squeeze setups, monitoring funding pressure precursors, and quantifying market positioning.',
  'https://proxy.suverse.io/v1/data/suverse-perp-open-interest',
  ARRAY['crypto','perpetual','open-interest','derivatives','leverage'],
  10000, 10000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-perp-open-interest',
  '{"symbol":"BTCUSDT"}',
  '{"symbol":"BTCUSDT","current_open_interest":85000.5,"current_open_interest_usd":5500000000,"change_24h_pct":3.21,"points":288,"history":[{"timestamp":1780000000000,"open_interest":82430.1,"open_interest_usd":5350000000}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 5. suverse-perp-funding-batch  ($0.01)
-- ─────────────────────────────────────────────────────────────────────
WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, price_atomic,
    accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos,
    forward_auth_scheme, is_active, upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'suverse-perp-funding-batch', 'suverse-perp-funding-batch',
    'https://proxy.suverse.io/v1/data/suverse-perp-funding-batch',
    'POST',
    'Batch Funding Rates Multi-Symbol',
    'Current funding rates for multiple Binance perpetual contracts in a single batch call. Returns each symbol mark price, funding rate, next funding timestamp, and predicted next rate. Essential for funding arbitrage AI agents, perp basis traders monitoring multiple pairs simultaneously, market makers tracking funding skew, and portfolio managers hedging exposure.',
    10000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static', true, false,
    'binance_funding_batch'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug = EXCLUDED.public_slug, display_name = EXCLUDED.display_name,
        description = EXCLUDED.description, price_atomic = EXCLUDED.price_atomic,
        accepted_networks = EXCLUDED.accepted_networks,
        pay_to_evm = EXCLUDED.pay_to_evm, pay_to_solana = EXCLUDED.pay_to_solana,
        pay_to_cosmos = EXCLUDED.pay_to_cosmos, updated_at = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url, tags,
  price_atomic_min, price_atomic_max, price_unit, networks, status,
  resource_key_id, slug, sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Batch Funding Rates Multi-Symbol',
  'Current funding rates for multiple Binance perpetual contracts in a single batch call. Returns each symbol mark price, funding rate, next funding timestamp, and predicted next rate. Essential for funding arbitrage AI agents, perp basis traders monitoring multiple pairs simultaneously, market makers tracking funding skew, and portfolio managers hedging exposure.',
  'https://proxy.suverse.io/v1/data/suverse-perp-funding-batch',
  ARRAY['crypto','perpetual','funding','batch','arbitrage'],
  10000, 10000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-perp-funding-batch',
  '{"symbols":["BTCUSDT","ETHUSDT","SOLUSDT"]}',
  '{"requested":3,"returned":3,"missing":[],"rates":[{"symbol":"BTCUSDT","mark_price":65432.1,"index_price":65430.0,"funding_rate":0.0001,"funding_rate_pct":0.01,"next_funding_time":1800000000000,"time":1790000000000}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 6. suverse-stablecoin-supply  ($0.01)
-- ─────────────────────────────────────────────────────────────────────
WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, price_atomic,
    accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos,
    forward_auth_scheme, is_active, upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'suverse-stablecoin-supply', 'suverse-stablecoin-supply',
    'https://proxy.suverse.io/v1/data/suverse-stablecoin-supply',
    'POST',
    'Stablecoin Circulating Supply by Chain',
    'Current circulating supply and per chain distribution for major stablecoins including USDT USDC DAI FDUSD PYUSD TUSD and Frax. Returns total supply, supply by chain Ethereum Tron BSC Solana Base Arbitrum, peg deviation if any, and 30 day supply change. Critical for AI agents tracking dollar liquidity migrations and on chain capital flows.',
    10000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static', true, false,
    'defillama_stablecoins'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug = EXCLUDED.public_slug, display_name = EXCLUDED.display_name,
        description = EXCLUDED.description, price_atomic = EXCLUDED.price_atomic,
        accepted_networks = EXCLUDED.accepted_networks,
        pay_to_evm = EXCLUDED.pay_to_evm, pay_to_solana = EXCLUDED.pay_to_solana,
        pay_to_cosmos = EXCLUDED.pay_to_cosmos, updated_at = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url, tags,
  price_atomic_min, price_atomic_max, price_unit, networks, status,
  resource_key_id, slug, sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Stablecoin Circulating Supply by Chain',
  'Current circulating supply and per chain distribution for major stablecoins including USDT USDC DAI FDUSD PYUSD TUSD and Frax. Returns total supply, supply by chain Ethereum Tron BSC Solana Base Arbitrum, peg deviation if any, and 30 day supply change. Critical for AI agents tracking dollar liquidity migrations and on chain capital flows.',
  'https://proxy.suverse.io/v1/data/suverse-stablecoin-supply',
  ARRAY['stablecoin','usdt','usdc','supply','analytics'],
  10000, 10000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-stablecoin-supply',
  '{}',
  '{"universe_size":150,"top_n":20,"top_n_total_supply_usd":200000000000,"stablecoins":[{"id":"1","name":"Tether","symbol":"USDT","peg_type":"peggedUSD","peg_mechanism":"fiat-backed","price_usd":0.999,"circulating_usd":120000000000,"chain_circulating":{"Ethereum":60000000000,"Tron":40000000000}}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 7. suverse-stock-quote  ($0.005) — INACTIVE until upstream unblocks
--
-- Yahoo Finance rate-limits `query1.finance.yahoo.com/v8/finance/chart`
-- aggressively from datacenter IPs — every call from this proxy
-- returned HTTP 429 during smoke. Handler maps that to 503 per spec,
-- but buyer would still be charged before settle returned. Seed
-- inactive; flip on when Yahoo unblocks or we add a chip-cookie path
-- / move to another stock data source.
-- ─────────────────────────────────────────────────────────────────────
WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, price_atomic,
    accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos,
    forward_auth_scheme, is_active, upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'suverse-stock-quote', 'suverse-stock-quote',
    'https://proxy.suverse.io/v1/data/suverse-stock-quote',
    'POST',
    'US Stock Real Time Quote',
    'Live quote for any US listed stock by ticker including price, day open high low close, previous close, percentage change, volume, 52 week high and low, and market state regular pre or post market. Perfect for AI portfolio managers, trading agents bridging crypto and tradfi, robo advisors, and dashboards needing real time equity prices.',
    5000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static', false, false,
    'yahoo_stock_quote'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug = EXCLUDED.public_slug, display_name = EXCLUDED.display_name,
        description = EXCLUDED.description, price_atomic = EXCLUDED.price_atomic,
        accepted_networks = EXCLUDED.accepted_networks,
        pay_to_evm = EXCLUDED.pay_to_evm, pay_to_solana = EXCLUDED.pay_to_solana,
        pay_to_cosmos = EXCLUDED.pay_to_cosmos, updated_at = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url, tags,
  price_atomic_min, price_atomic_max, price_unit, networks, status,
  resource_key_id, slug, sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'US Stock Real Time Quote',
  'Live quote for any US listed stock by ticker including price, day open high low close, previous close, percentage change, volume, 52 week high and low, and market state regular pre or post market. Perfect for AI portfolio managers, trading agents bridging crypto and tradfi, robo advisors, and dashboards needing real time equity prices.',
  'https://proxy.suverse.io/v1/data/suverse-stock-quote',
  ARRAY['stocks','us','quote','realtime','tradfi'],
  5000, 5000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'pending', proxy_ins.resource_key_id, 'suverse-stock-quote',
  '{"symbol":"AAPL"}',
  '{"symbol":"AAPL","exchange":"NMS","currency":"USD","price":200.42,"previous_close":195.20,"change_pct":2.67,"day_high":201.11,"day_low":197.50,"volume":52345678,"fifty_two_week_high":220.0,"fifty_two_week_low":150.0,"market_state":"REGULAR","pre_market_price":null,"post_market_price":null,"regular_market_time":1780000000}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 8. suverse-stock-batch-quotes  ($0.01) — INACTIVE: same Yahoo block.
-- ─────────────────────────────────────────────────────────────────────
WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, price_atomic,
    accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos,
    forward_auth_scheme, is_active, upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'suverse-stock-batch-quotes', 'suverse-stock-batch-quotes',
    'https://proxy.suverse.io/v1/data/suverse-stock-batch-quotes',
    'POST',
    'Batch US Stock Quotes Up To 50 Tickers',
    'Live quotes for up to 50 US stock tickers in a single API call. Returns price, percentage change, volume, market cap, and pre or post market quote when available for each ticker. Ideal for AI portfolio refresh, comparative analysis across watchlist, sector rotation detection, and dashboards displaying multiple positions in one call.',
    10000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static', false, false,
    'yahoo_stock_batch'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug = EXCLUDED.public_slug, display_name = EXCLUDED.display_name,
        description = EXCLUDED.description, price_atomic = EXCLUDED.price_atomic,
        accepted_networks = EXCLUDED.accepted_networks,
        pay_to_evm = EXCLUDED.pay_to_evm, pay_to_solana = EXCLUDED.pay_to_solana,
        pay_to_cosmos = EXCLUDED.pay_to_cosmos, updated_at = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url, tags,
  price_atomic_min, price_atomic_max, price_unit, networks, status,
  resource_key_id, slug, sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Batch US Stock Quotes Up To 50 Tickers',
  'Live quotes for up to 50 US stock tickers in a single API call. Returns price, percentage change, volume, market cap, and pre or post market quote when available for each ticker. Ideal for AI portfolio refresh, comparative analysis across watchlist, sector rotation detection, and dashboards displaying multiple positions in one call.',
  'https://proxy.suverse.io/v1/data/suverse-stock-batch-quotes',
  ARRAY['stocks','batch','portfolio','quotes','tradfi'],
  10000, 10000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'pending', proxy_ins.resource_key_id, 'suverse-stock-batch-quotes',
  '{"symbols":["AAPL","GOOGL","TSLA","NVDA"]}',
  '{"requested":4,"returned":4,"missing":[],"quotes":[{"symbol":"AAPL","short_name":"Apple Inc.","long_name":"Apple Inc.","exchange":"NMS","currency":"USD","market_state":"REGULAR","price":200.42,"change":5.22,"change_pct":2.67,"volume":52345678,"market_cap":3000000000000}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 9. suverse-forex-rates  ($0.005)
-- ─────────────────────────────────────────────────────────────────────
WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, price_atomic,
    accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos,
    forward_auth_scheme, is_active, upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'suverse-forex-rates', 'suverse-forex-rates',
    'https://proxy.suverse.io/v1/data/suverse-forex-rates',
    'POST',
    'Batch Foreign Exchange Rates',
    'Current exchange rates for up to 30 currency pairs in a single call. Returns each pair quote and last update date. Covers all major fiat currencies including USD EUR GBP JPY CHF AUD CAD CNY and emerging market currencies. Critical for AI agents performing cross border calculations, forex arbitrage detection, and international portfolio valuation.',
    5000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static', true, false,
    'frankfurter_rates_batch'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug = EXCLUDED.public_slug, display_name = EXCLUDED.display_name,
        description = EXCLUDED.description, price_atomic = EXCLUDED.price_atomic,
        accepted_networks = EXCLUDED.accepted_networks,
        pay_to_evm = EXCLUDED.pay_to_evm, pay_to_solana = EXCLUDED.pay_to_solana,
        pay_to_cosmos = EXCLUDED.pay_to_cosmos, updated_at = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url, tags,
  price_atomic_min, price_atomic_max, price_unit, networks, status,
  resource_key_id, slug, sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Batch Foreign Exchange Rates',
  'Current exchange rates for up to 30 currency pairs in a single call. Returns each pair quote and last update date. Covers all major fiat currencies including USD EUR GBP JPY CHF AUD CAD CNY and emerging market currencies. Critical for AI agents performing cross border calculations, forex arbitrage detection, and international portfolio valuation.',
  'https://proxy.suverse.io/v1/data/suverse-forex-rates',
  ARRAY['forex','fx','rates','currency','batch'],
  5000, 5000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-forex-rates',
  '{"base":"USD","symbols":["EUR","GBP","JPY","CHF"]}',
  '{"base":"USD","date":"2026-06-01","requested":4,"returned":4,"missing":[],"rates":{"EUR":0.92,"GBP":0.78,"JPY":156.32,"CHF":0.89}}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 10. suverse-forex-historical  ($0.01)
-- ─────────────────────────────────────────────────────────────────────
WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, price_atomic,
    accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos,
    forward_auth_scheme, is_active, upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'suverse-forex-historical', 'suverse-forex-historical',
    'https://proxy.suverse.io/v1/data/suverse-forex-historical',
    'POST',
    'Historical Foreign Exchange Rate',
    'Historical daily foreign exchange rate for any currency pair on any date going back to 1999. Returns the official ECB reference rate for that date including all major and emerging currencies. Perfect for AI agents reconciling historical transactions, computing time period returns, regulatory reporting at past rates, and academic financial research.',
    10000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static', true, false,
    'frankfurter_historical'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug = EXCLUDED.public_slug, display_name = EXCLUDED.display_name,
        description = EXCLUDED.description, price_atomic = EXCLUDED.price_atomic,
        accepted_networks = EXCLUDED.accepted_networks,
        pay_to_evm = EXCLUDED.pay_to_evm, pay_to_solana = EXCLUDED.pay_to_solana,
        pay_to_cosmos = EXCLUDED.pay_to_cosmos, updated_at = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url, tags,
  price_atomic_min, price_atomic_max, price_unit, networks, status,
  resource_key_id, slug, sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Historical Foreign Exchange Rate',
  'Historical daily foreign exchange rate for any currency pair on any date going back to 1999. Returns the official ECB reference rate for that date including all major and emerging currencies. Perfect for AI agents reconciling historical transactions, computing time period returns, regulatory reporting at past rates, and academic financial research.',
  'https://proxy.suverse.io/v1/data/suverse-forex-historical',
  ARRAY['forex','historical','fx','rate','ecb'],
  10000, 10000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-forex-historical',
  '{"date":"2025-01-15","base":"USD","symbol":"EUR"}',
  '{"requested_date":"2025-01-15","effective_date":"2025-01-15","base":"USD","symbol":"EUR","rate":0.9651,"rolled_back":false}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

COMMIT;
