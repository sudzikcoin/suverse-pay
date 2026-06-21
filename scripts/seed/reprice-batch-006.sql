-- reprice-batch-006.sql — bring batch-006 Group A (prediction markets) into
-- the $0.05-0.10 per-call pricing rule. Data-only, idempotent, no schema
-- change. USDC 6-decimals: $0.05 = 50000, $0.10 = 100000.
--
-- Scope: the EXACT 30 batch-006 public_slugs, so the 4 pre-existing bespoke
-- polymarket endpoints (smart-bias / whale-entries / position-holders /
-- trader-skill) are never touched.
--
-- $0.10 (100000): the 10 higher-value data shapes (live order book, price
--                 history, trade tapes, holders, wallet positions/activity,
--                 trending board) across BOTH Polymarket and Kalshi.
-- $0.05 (50000):  the remaining 20 (floor).
--
-- Updates BOTH the charge (seller_proxy_configs.price_atomic, picked up by
-- the ~60s config cache) AND the advertised price
-- (catalog_listings.price_atomic_min/max, which feeds /openapi.json) so the
-- 402 charge and our own discovery surface stay in sync. CDP's cached copy
-- still needs its own re-index to refresh (out of scope here).
BEGIN;

-- 1a. Charge: floor everything to $0.05.
UPDATE seller_proxy_configs
SET price_atomic = 50000, updated_at = now()
WHERE public_slug IN (
  'polymarket-markets','polymarket-market-detail','polymarket-events',
  'polymarket-event-detail','polymarket-trending-markets','polymarket-new-markets',
  'polymarket-markets-by-tag','polymarket-tags','polymarket-resolved-markets',
  'polymarket-market-by-slug','polymarket-orderbook','polymarket-midpoint-price',
  'polymarket-token-price','polymarket-price-history','polymarket-bid-ask-spread',
  'polymarket-clob-markets','polymarket-recent-trades','polymarket-market-holders',
  'polymarket-wallet-positions','polymarket-wallet-value','polymarket-wallet-activity',
  'polymarket-market-trades','kalshi-markets','kalshi-events','kalshi-market-detail',
  'kalshi-event-detail','kalshi-open-markets','kalshi-market-orderbook',
  'kalshi-series-detail','kalshi-market-trades'
)
AND price_atomic <> 50000;

-- 1b. Charge: bump the 10 higher-value shapes to $0.10 (incl. Kalshi orderbook + trades).
UPDATE seller_proxy_configs
SET price_atomic = 100000, updated_at = now()
WHERE public_slug IN (
  'polymarket-orderbook','polymarket-price-history','polymarket-recent-trades',
  'polymarket-market-holders','polymarket-wallet-positions','polymarket-wallet-activity',
  'polymarket-trending-markets','polymarket-market-trades',
  'kalshi-market-orderbook','kalshi-market-trades'
)
AND price_atomic <> 100000;

-- 2. Advertised price: sync catalog_listings to the charge so /openapi.json
--    matches the 402. min == max (fixed price). Joined by proxy_config_id.
UPDATE catalog_listings cl
SET price_atomic_min = spc.price_atomic,
    price_atomic_max = spc.price_atomic,
    updated_at = now()
FROM seller_proxy_configs spc
WHERE cl.proxy_config_id = spc.id
  AND spc.public_slug IN (
    'polymarket-markets','polymarket-market-detail','polymarket-events',
    'polymarket-event-detail','polymarket-trending-markets','polymarket-new-markets',
    'polymarket-markets-by-tag','polymarket-tags','polymarket-resolved-markets',
    'polymarket-market-by-slug','polymarket-orderbook','polymarket-midpoint-price',
    'polymarket-token-price','polymarket-price-history','polymarket-bid-ask-spread',
    'polymarket-clob-markets','polymarket-recent-trades','polymarket-market-holders',
    'polymarket-wallet-positions','polymarket-wallet-value','polymarket-wallet-activity',
    'polymarket-market-trades','kalshi-markets','kalshi-events','kalshi-market-detail',
    'kalshi-event-detail','kalshi-open-markets','kalshi-market-orderbook',
    'kalshi-series-detail','kalshi-market-trades'
  )
  AND (cl.price_atomic_min <> spc.price_atomic OR cl.price_atomic_max <> spc.price_atomic);

COMMIT;
