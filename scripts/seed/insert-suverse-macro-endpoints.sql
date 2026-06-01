-- Seed: four first-party "macro" endpoints — crypto fear-and-greed
-- (alternative.me), SEC EDGAR filings (sec.gov), and precious-metals +
-- oil spot quotes (Stooq CSV). Idempotent — re-runs safe via UPSERT.
--
-- The fifth requested endpoint in this batch (stock-ohlc-history) was
-- dropped because every viable free upstream now requires a key —
-- Yahoo Finance rate-limits DC IPs, Stooq's daily-history endpoint
-- moved behind a captcha-bound key. Held until the user provisions
-- a paid data source. Handler code intentionally not shipped to keep
-- the registry honest.
--
-- Descriptions ASCII-only, 335-365 chars, no Unicode dashes.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. suverse-fear-greed-index  ($0.005)
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
    'suverse-fear-greed-index', 'suverse-fear-greed-index',
    'https://proxy.suverse.io/v1/data/suverse-fear-greed-index',
    'POST',
    'Crypto Fear and Greed Index',
    'Current crypto market fear and greed sentiment index value from 0 extreme fear to 100 extreme greed with classification label. Returns current score, classification text, 30 day historical values for trend analysis, and timestamp. Critical for AI agents detecting market sentiment extremes, contrarian trading signals, and risk management triggers.',
    5000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static', true, false,
    'fear_greed_index'
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
  'Crypto Fear and Greed Index',
  'Current crypto market fear and greed sentiment index value from 0 extreme fear to 100 extreme greed with classification label. Returns current score, classification text, 30 day historical values for trend analysis, and timestamp. Critical for AI agents detecting market sentiment extremes, contrarian trading signals, and risk management triggers.',
  'https://proxy.suverse.io/v1/data/suverse-fear-greed-index',
  ARRAY['crypto','sentiment','fear-greed','market-psychology','contrarian'],
  5000, 5000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-fear-greed-index',
  '{}',
  '{"current_value":29,"classification":"Fear","timestamp":1780272000,"next_update_seconds":63630,"window_days":30,"historical":[{"value":29,"classification":"Fear","timestamp":1780272000},{"value":28,"classification":"Fear","timestamp":1780185600}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 2. suverse-sec-filings  ($0.01)
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
    'suverse-sec-filings', 'suverse-sec-filings',
    'https://proxy.suverse.io/v1/data/suverse-sec-filings',
    'POST',
    'Recent SEC Filings for US Ticker',
    'Latest SEC EDGAR filings for any US listed company including 10K annual report, 10Q quarterly, 8K current report material events, S1 IPO filings, and insider transactions Form 4. Returns each filing date, form type, accession number, and direct URL to filing document. Critical for AI agents tracking material corporate events and insider activity.',
    10000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static', true, false,
    'sec_filings'
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
  'Recent SEC Filings for US Ticker',
  'Latest SEC EDGAR filings for any US listed company including 10K annual report, 10Q quarterly, 8K current report material events, S1 IPO filings, and insider transactions Form 4. Returns each filing date, form type, accession number, and direct URL to filing document. Critical for AI agents tracking material corporate events and insider activity.',
  'https://proxy.suverse.io/v1/data/suverse-sec-filings',
  ARRAY['stocks','sec','filings','tradfi','edgar'],
  10000, 10000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-sec-filings',
  '{"ticker":"AAPL","limit":20}',
  '{"ticker":"AAPL","cik":"0000320193","name":"Apple Inc.","tickers":["AAPL"],"exchanges":["Nasdaq"],"count":1,"filings":[{"form":"10-Q","filing_date":"2026-05-02","report_date":"2026-03-29","accession_number":"0000320193-26-000001","primary_document":"aapl-20260329.htm","primary_doc_description":"10-Q","is_xbrl":true,"filing_url":"https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/aapl-20260329.htm"}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 3. suverse-precious-metals  ($0.005)
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
    'suverse-precious-metals', 'suverse-precious-metals',
    'https://proxy.suverse.io/v1/data/suverse-precious-metals',
    'POST',
    'Precious Metals Spot Prices',
    'Current spot prices in USD per troy ounce for gold, silver, platinum, and palladium with the latest open high low close from Stooq quote feed. Essential for AI agents performing cross asset analysis between metals and crypto, inflation hedge tracking, portfolio diversification calculations, and gold to bitcoin ratio analysis.',
    5000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static', true, false,
    'stooq_precious_metals'
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
  'Precious Metals Spot Prices',
  'Current spot prices in USD per troy ounce for gold, silver, platinum, and palladium with the latest open high low close from Stooq quote feed. Essential for AI agents performing cross asset analysis between metals and crypto, inflation hedge tracking, portfolio diversification calculations, and gold to bitcoin ratio analysis.',
  'https://proxy.suverse.io/v1/data/suverse-precious-metals',
  ARRAY['commodities','gold','silver','metals','inflation-hedge'],
  5000, 5000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-precious-metals',
  '{}',
  '{"count":4,"currency":"USD","unit":"troy_ounce","metals":[{"symbol":"XAUUSD","metal":"gold","date":"2026-06-01","time":"08:00:00","open":4523.02,"high":4545.72,"low":4509.38,"close":4514.06,"name":"XAU/USD"},{"symbol":"XAGUSD","metal":"silver","date":"2026-06-01","time":"08:00:00","open":74.10,"high":76.04,"low":74.10,"close":75.70,"name":"XAG/USD"}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 4. suverse-oil-prices  ($0.005)
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
    'suverse-oil-prices', 'suverse-oil-prices',
    'https://proxy.suverse.io/v1/data/suverse-oil-prices',
    'POST',
    'WTI and Brent Oil Spot Prices',
    'Current WTI NYMEX and Brent ICE crude oil front month futures spot prices in USD per barrel with open high low close and the Brent minus WTI spread computed for arbitrage agents. Critical for AI agents analyzing energy markets, geopolitical risk, inflation tracking, energy sector trading, and macro correlation analysis.',
    5000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static', true, false,
    'stooq_oil_prices'
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
  'WTI and Brent Oil Spot Prices',
  'Current WTI NYMEX and Brent ICE crude oil front month futures spot prices in USD per barrel with open high low close and the Brent minus WTI spread computed for arbitrage agents. Critical for AI agents analyzing energy markets, geopolitical risk, inflation tracking, energy sector trading, and macro correlation analysis.',
  'https://proxy.suverse.io/v1/data/suverse-oil-prices',
  ARRAY['commodities','oil','wti','brent','energy'],
  5000, 5000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-oil-prices',
  '{}',
  '{"currency":"USD","unit":"barrel","wti":{"symbol":"CL.F","benchmark":"wti","date":"2026-06-01","time":"08:00:00","open":88.95,"high":90.11,"low":88.78,"close":90.03,"name":"CRUDE OIL WTI"},"brent":{"symbol":"CB.F","benchmark":"brent","date":"2026-06-01","time":"08:00:00","open":92.53,"high":93.69,"low":92.48,"close":93.59,"name":"CRUDE OIL BRENT"},"brent_wti_spread":3.56,"count":2}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

COMMIT;
