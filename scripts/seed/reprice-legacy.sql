-- reprice-legacy.sql
-- Enforce the $0.05-0.10 pricing rule across the WHOLE legacy catalog —
-- the 49 sub-$0.05 active endpoints that predated the batch pipeline
-- (2026-05-31 / 06-01 cohort) plus the un-bumped 06-21 batch-007/009
-- stragglers. Audit: REPORT-price-audit-20260624.md §2.
--
-- Scope decisions (see REPORT-reprice-20260624.md):
--   * bazaar-test  -> EXCLUDED (internal test, stays $0.001, no catalog row).
--   * suverse-base-swap / suverse-solana-swap -> EXCLUDED per owner: a
--     deliberate $0.001 swap-exec fee + $50M size ceiling, not a feed.
--   * coingecko-btc -> price floored for histogram hygiene, but NO catalog
--     row created: it has NULL public_slug, so it is not routable at
--     /v1/data/*, not in openapi.json, and cannot be reindexed. Dormant
--     dup of bazaar-test; activation/retirement is an owner decision.
--
-- Buckets:
--   $0.05 (50000)  simple single-value feeds
--   $0.10 (100000) richer / compute / proprietary endpoints
--
-- Updates BOTH seller_proxy_configs.price_atomic AND
-- catalog_listings.price_atomic_{min,max}, joined via the FK
-- proxy_config_id (NOT slug — so the legacy-slug rows update correctly).
-- Also aligns the 11 legacy catalog slugs to the proxy public_slug.
--
-- Fully idempotent: explicit value lists, slug-align is a no-op on re-run.
-- Safe to re-run.

BEGIN;

-- ----------------------------------------------------------------------
-- PART 1a — $0.10 bucket (21 richer / compute / proprietary)
-- ----------------------------------------------------------------------
UPDATE seller_proxy_configs SET price_atomic = 100000, updated_at = now()
WHERE is_active = true AND public_slug IN (
  'smart-money-base','smart-money-cosmos','smart-money-netflow',
  'polymarket-whale-entries','wallet-reputation','wallet-scam-check',
  'token-quicklook','dex-trending-pools','dex-new-pools',
  'suverse-perp-funding','suverse-perp-open-interest','suverse-perp-funding-batch',
  'suverse-defi-protocol-tvl','suverse-defi-fees','suverse-defi-yield-pools',
  'suverse-ta-rsi','suverse-ta-macd','suverse-ta-moving-averages',
  'suverse-crypto-ohlc-history','suverse-sec-filings','suverse-stablecoin-supply'
);

-- ----------------------------------------------------------------------
-- PART 1b — $0.05 bucket (27 routable simple feeds, by public_slug)
-- ----------------------------------------------------------------------
UPDATE seller_proxy_configs SET price_atomic = 50000, updated_at = now()
WHERE is_active = true AND public_slug IN (
  'binance-btc-spot','coinbase-btc-spot','fiat-exchange-rates','ip-geolocation',
  'weather-forecast-nyc','ethereum-gas-tracker','bitcoin-fees-recommended',
  'bitcoin-mempool-stats','defillama-tvl','suverse-binance-orderbook',
  'suverse-binance-trades','suverse-crypto-price-batch','suverse-crypto-trending',
  'suverse-fear-greed-index','suverse-forex-rates','suverse-oil-prices',
  'suverse-precious-metals','bitcoin-block-info','coingecko-btc-eth-prices',
  'geckoterminal-eth-pools','suverse-base-dex-pools','suverse-crypto-24h-movers',
  'suverse-crypto-market-rankings','suverse-defi-tvl-chain','suverse-forex-historical',
  'suverse-solana-dex-pools','suverse-solana-priority-fee'
);

-- PART 1b' — coingecko-btc (NULL public_slug, keyed by endpoint_slug).
-- Floor only; not routable, gets no catalog row / no reindex.
UPDATE seller_proxy_configs SET price_atomic = 50000, updated_at = now()
WHERE is_active = true AND endpoint_slug = 'coingecko-btc' AND public_slug IS NULL;

-- ----------------------------------------------------------------------
-- PART 1c — mirror the new prices into catalog_listings via FK.
-- price_atomic_min = price_atomic_max = the per-call price.
-- ----------------------------------------------------------------------
UPDATE catalog_listings cl
SET price_atomic_min = spc.price_atomic,
    price_atomic_max = spc.price_atomic,
    updated_at = now()
FROM seller_proxy_configs spc
WHERE cl.proxy_config_id = spc.id
  AND spc.is_active = true
  AND spc.public_slug IN (
    -- $0.10 set
    'smart-money-base','smart-money-cosmos','smart-money-netflow',
    'polymarket-whale-entries','wallet-reputation','wallet-scam-check',
    'token-quicklook','dex-trending-pools','dex-new-pools',
    'suverse-perp-funding','suverse-perp-open-interest','suverse-perp-funding-batch',
    'suverse-defi-protocol-tvl','suverse-defi-fees','suverse-defi-yield-pools',
    'suverse-ta-rsi','suverse-ta-macd','suverse-ta-moving-averages',
    'suverse-crypto-ohlc-history','suverse-sec-filings','suverse-stablecoin-supply',
    -- $0.05 set
    'binance-btc-spot','coinbase-btc-spot','fiat-exchange-rates','ip-geolocation',
    'weather-forecast-nyc','ethereum-gas-tracker','bitcoin-fees-recommended',
    'bitcoin-mempool-stats','defillama-tvl','suverse-binance-orderbook',
    'suverse-binance-trades','suverse-crypto-price-batch','suverse-crypto-trending',
    'suverse-fear-greed-index','suverse-forex-rates','suverse-oil-prices',
    'suverse-precious-metals','bitcoin-block-info','coingecko-btc-eth-prices',
    'geckoterminal-eth-pools','suverse-base-dex-pools','suverse-crypto-24h-movers',
    'suverse-crypto-market-rankings','suverse-defi-tvl-chain','suverse-forex-historical',
    'suverse-solana-dex-pools','suverse-solana-priority-fee'
  );

-- ----------------------------------------------------------------------
-- PART 2 — Side issue A: align the 11 legacy catalog slugs to the proxy
-- public_slug so discovery/crawlers key on the same name. Safe: openapi
-- and the live /v1/data/* route key on public_slug + endpoint_url, never
-- catalog_listings.slug, so no served URL or CDP registration changes.
-- Guarded by cl.slug <> public_slug -> no-op on re-run.
-- ----------------------------------------------------------------------
UPDATE catalog_listings cl
SET slug = spc.public_slug, updated_at = now()
FROM seller_proxy_configs spc
WHERE cl.proxy_config_id = spc.id
  AND spc.public_slug IS NOT NULL
  AND cl.slug IS DISTINCT FROM spc.public_slug
  AND spc.public_slug IN (
    'binance-btc-spot','coinbase-btc-spot','coingecko-btc-eth-prices',
    'defillama-tvl','ethereum-gas-tracker','fiat-exchange-rates',
    'geckoterminal-eth-pools','ip-geolocation','weather-forecast-nyc',
    'solana-tx-decoder','solana-tx-simulator'
  );

-- ----------------------------------------------------------------------
-- PART 3 — Side issue B: missing catalog rows.
-- Only 2 active endpoints have no FK-linked catalog row:
--   bazaar-test    -> internal test endpoint, intentionally no row.
--   coingecko-btc  -> NULL public_slug, not routable/sellable -> no row.
-- Both are correctly left rowless. No INSERT here by design.
-- ----------------------------------------------------------------------

COMMIT;
