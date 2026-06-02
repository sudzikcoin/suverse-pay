-- 031_bitcoin_and_ta_categories.sql — split 8 'other' listings into
-- two dedicated categories.
--
-- Migration 030 backfilled every listing onto a v1 taxonomy but left
-- 11 residuals under `other`. Two clusters were large enough to make
-- the catalog UX worse by hiding them:
--
--   bitcoin-tools (5):  bitcoin-address-info, bitcoin-block-info,
--                       bitcoin-fees-recommended, bitcoin-mempool-stats,
--                       bitcoin-tx-decoder
--   technical-analysis (3):  suverse-ta-macd, suverse-ta-moving-averages,
--                            suverse-ta-rsi
--
-- v1 taxonomy is therefore extended by 2 categories:
--   bitcoin-tools, technical-analysis
--
-- The remaining `other` residuals (ip-geolocation-lookup-6faf21,
-- suverse-nft-metadata, suverse-wallet-history) stay there until they
-- accumulate enough siblings to justify their own bucket.

-- bitcoin-tools
UPDATE catalog_listings SET category = 'bitcoin-tools'      WHERE slug = 'bitcoin-address-info';
UPDATE catalog_listings SET category = 'bitcoin-tools'      WHERE slug = 'bitcoin-block-info';
UPDATE catalog_listings SET category = 'bitcoin-tools'      WHERE slug = 'bitcoin-fees-recommended';
UPDATE catalog_listings SET category = 'bitcoin-tools'      WHERE slug = 'bitcoin-mempool-stats';
UPDATE catalog_listings SET category = 'bitcoin-tools'      WHERE slug = 'bitcoin-tx-decoder';

-- technical-analysis
UPDATE catalog_listings SET category = 'technical-analysis' WHERE slug = 'suverse-ta-macd';
UPDATE catalog_listings SET category = 'technical-analysis' WHERE slug = 'suverse-ta-moving-averages';
UPDATE catalog_listings SET category = 'technical-analysis' WHERE slug = 'suverse-ta-rsi';
