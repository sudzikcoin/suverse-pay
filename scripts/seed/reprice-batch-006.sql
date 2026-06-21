-- reprice-batch-006.sql — bring batch-006 Group A (prediction markets) into
-- the $0.05-0.10 per-call pricing rule. Data-only UPDATE on
-- seller_proxy_configs.price_atomic (USDC 6-decimals): $0.05 = 50000,
-- $0.10 = 100000. No schema change, no redeploy — the proxy config cache
-- (~60s TTL) picks it up. Does NOT touch CDP listings or re-index.
--
-- Idempotent: re-running sets the same values (guarded by <> so a second
-- run is a no-op). Scoped by the EXACT 30 batch-006 public_slugs so the 4
-- pre-existing bespoke polymarket endpoints (smart-bias / whale-entries /
-- position-holders / trader-skill) are never touched.
--
-- $0.10 (100000): the 8 higher-value data shapes (live order book, price
-- history, trade tapes, holders, wallet positions/activity, trending board).
-- $0.05 (50000):  the remaining 22 (floor).
BEGIN;

-- Floor: $0.05 for all 30 batch-006 endpoints.
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

-- Bump: $0.10 for the 8 higher-value shapes.
UPDATE seller_proxy_configs
SET price_atomic = 100000, updated_at = now()
WHERE public_slug IN (
  'polymarket-orderbook','polymarket-price-history','polymarket-recent-trades',
  'polymarket-market-holders','polymarket-wallet-positions','polymarket-wallet-activity',
  'polymarket-trending-markets','polymarket-market-trades'
)
AND price_atomic <> 100000;

COMMIT;
