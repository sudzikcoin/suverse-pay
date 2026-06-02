-- 030_endpoint_categories.sql — backfill catalog_listings.category.
--
-- 60+ approved listings shipped with NULL category (or a free-text
-- legacy value like "trading"/"market-data") which renders as
-- "UNCATEGORIZED" on /catalog and breaks both the sidebar filter and
-- the new card-level category badge.
--
-- This migration standardises every approved listing onto the v1
-- category taxonomy. Categories are explicit per-slug so the mapping
-- is auditable: when someone disagrees with how `suverse-perp-funding`
-- got classified, `git blame` shows exactly when and why.
--
-- v1 taxonomy:
--   swap, crypto-prices, solana-tools, base-tools, cosmos-tools,
--   defi-data, market-sentiment, forex, weather, commodities,
--   sec-filings, other
--
-- seller_proxy_configs has NO `category` column (verified at
-- migration-authoring time) — catalog is the only surface that needs
-- this metadata. If a future migration adds the column to
-- seller_proxy_configs, mirror the same UPDATEs there.

-- swap
UPDATE catalog_listings SET category = 'swap'           WHERE slug = 'suverse-base-swap';
UPDATE catalog_listings SET category = 'swap'           WHERE slug = 'suverse-solana-swap';

-- crypto-prices (spot/ticker/orderbook/quote/market-data feeds)
UPDATE catalog_listings SET category = 'crypto-prices'  WHERE slug = 'binance-btc-usdt-spot-price-bf7ffc';
UPDATE catalog_listings SET category = 'crypto-prices'  WHERE slug = 'btc-spot-price-test-bazaar';
UPDATE catalog_listings SET category = 'crypto-prices'  WHERE slug = 'btc-spot-price-test-bazaar-api';
UPDATE catalog_listings SET category = 'crypto-prices'  WHERE slug = 'coinbase-btc-usd-spot-price-5427e7';
UPDATE catalog_listings SET category = 'crypto-prices'  WHERE slug = 'coingecko-btc-clean-url';
UPDATE catalog_listings SET category = 'crypto-prices'  WHERE slug = 'coingecko-btc-eth-price-dd69e9';
UPDATE catalog_listings SET category = 'crypto-prices'  WHERE slug = 'suverse-binance-orderbook';
UPDATE catalog_listings SET category = 'crypto-prices'  WHERE slug = 'suverse-binance-trades';
UPDATE catalog_listings SET category = 'crypto-prices'  WHERE slug = 'suverse-crypto-24h-movers';
UPDATE catalog_listings SET category = 'crypto-prices'  WHERE slug = 'suverse-crypto-market-rankings';
UPDATE catalog_listings SET category = 'crypto-prices'  WHERE slug = 'suverse-crypto-ohlc-history';
UPDATE catalog_listings SET category = 'crypto-prices'  WHERE slug = 'suverse-crypto-price-batch';
UPDATE catalog_listings SET category = 'crypto-prices'  WHERE slug = 'suverse-crypto-trending';
UPDATE catalog_listings SET category = 'crypto-prices'  WHERE slug = 'suverse-stock-batch-quotes';
UPDATE catalog_listings SET category = 'crypto-prices'  WHERE slug = 'suverse-stock-quote';

-- solana-tools (tx decoding/simulation, dex pools, priority fees, spl)
UPDATE catalog_listings SET category = 'solana-tools'   WHERE slug = 'solana-tx-decoder-9e7a7f';
UPDATE catalog_listings SET category = 'solana-tools'   WHERE slug = 'solana-tx-simulator-059a9f';
UPDATE catalog_listings SET category = 'solana-tools'   WHERE slug = 'spl-token-safety-check-1457d8';
UPDATE catalog_listings SET category = 'solana-tools'   WHERE slug = 'suverse-solana-dex-pools';
UPDATE catalog_listings SET category = 'solana-tools'   WHERE slug = 'suverse-solana-priority-fee';
UPDATE catalog_listings SET category = 'solana-tools'   WHERE slug = 'suverse-solana-tx-decoder';
UPDATE catalog_listings SET category = 'solana-tools'   WHERE slug = 'suverse-solana-tx-simulator';

-- base-tools (Base/EVM contract/wallet/tx lookups + gas)
UPDATE catalog_listings SET category = 'base-tools'     WHERE slug = 'base-contract-info';
UPDATE catalog_listings SET category = 'base-tools'     WHERE slug = 'base-token-holders';
UPDATE catalog_listings SET category = 'base-tools'     WHERE slug = 'base-tx-decoder';
UPDATE catalog_listings SET category = 'base-tools'     WHERE slug = 'base-wallet-history';
UPDATE catalog_listings SET category = 'base-tools'     WHERE slug = 'ethereum-gas-tracker-f3aca5';
UPDATE catalog_listings SET category = 'base-tools'     WHERE slug = 'evm-token-risk-base';

-- cosmos-tools (chain info, validators, ibc, wallet, tx)
UPDATE catalog_listings SET category = 'cosmos-tools'   WHERE slug = 'cosmos-chain-info';
UPDATE catalog_listings SET category = 'cosmos-tools'   WHERE slug = 'cosmos-ibc-tracker';
UPDATE catalog_listings SET category = 'cosmos-tools'   WHERE slug = 'cosmos-tx-decoder';
UPDATE catalog_listings SET category = 'cosmos-tools'   WHERE slug = 'cosmos-validator-stats';
UPDATE catalog_listings SET category = 'cosmos-tools'   WHERE slug = 'cosmos-wallet-balance';

-- defi-data (TVL, dex pools, bridge volumes, fees, stablecoins, perps)
UPDATE catalog_listings SET category = 'defi-data'      WHERE slug = 'defillama-all-protocols-tvl-5903df';
UPDATE catalog_listings SET category = 'defi-data'      WHERE slug = 'geckoterminal-ethereum-dex-pools-205594';
UPDATE catalog_listings SET category = 'defi-data'      WHERE slug = 'suverse-base-dex-pools';
UPDATE catalog_listings SET category = 'defi-data'      WHERE slug = 'suverse-bridge-volumes';
UPDATE catalog_listings SET category = 'defi-data'      WHERE slug = 'suverse-defi-fees';
UPDATE catalog_listings SET category = 'defi-data'      WHERE slug = 'suverse-defi-protocol-tvl';
UPDATE catalog_listings SET category = 'defi-data'      WHERE slug = 'suverse-defi-tvl-chain';
UPDATE catalog_listings SET category = 'defi-data'      WHERE slug = 'suverse-defi-yield-pools';
UPDATE catalog_listings SET category = 'defi-data'      WHERE slug = 'suverse-stablecoin-supply';
UPDATE catalog_listings SET category = 'defi-data'      WHERE slug = 'suverse-perp-funding';
UPDATE catalog_listings SET category = 'defi-data'      WHERE slug = 'suverse-perp-funding-batch';
UPDATE catalog_listings SET category = 'defi-data'      WHERE slug = 'suverse-perp-open-interest';

-- market-sentiment
UPDATE catalog_listings SET category = 'market-sentiment' WHERE slug = 'suverse-fear-greed-index';

-- forex
UPDATE catalog_listings SET category = 'forex'          WHERE slug = 'fiat-exchange-rates-usd-base-cc6af7';
UPDATE catalog_listings SET category = 'forex'          WHERE slug = 'suverse-forex-historical';
UPDATE catalog_listings SET category = 'forex'          WHERE slug = 'suverse-forex-rates';

-- weather
UPDATE catalog_listings SET category = 'weather'        WHERE slug = 'weather-forecast-nyc-default-993c8b';

-- commodities (oil + precious metals)
UPDATE catalog_listings SET category = 'commodities'    WHERE slug = 'suverse-oil-prices';
UPDATE catalog_listings SET category = 'commodities'    WHERE slug = 'suverse-precious-metals';

-- sec-filings
UPDATE catalog_listings SET category = 'sec-filings'    WHERE slug = 'suverse-sec-filings';

-- other (residuals: bitcoin chain tools, geolocation, NFT metadata,
-- technical-analysis indicators, multichain wallet history). See the
-- final report for follow-up suggestions on splitting these into
-- dedicated categories.
UPDATE catalog_listings SET category = 'other'          WHERE slug = 'bitcoin-address-info';
UPDATE catalog_listings SET category = 'other'          WHERE slug = 'bitcoin-block-info';
UPDATE catalog_listings SET category = 'other'          WHERE slug = 'bitcoin-fees-recommended';
UPDATE catalog_listings SET category = 'other'          WHERE slug = 'bitcoin-mempool-stats';
UPDATE catalog_listings SET category = 'other'          WHERE slug = 'bitcoin-tx-decoder';
UPDATE catalog_listings SET category = 'other'          WHERE slug = 'ip-geolocation-lookup-6faf21';
UPDATE catalog_listings SET category = 'other'          WHERE slug = 'suverse-nft-metadata';
UPDATE catalog_listings SET category = 'other'          WHERE slug = 'suverse-ta-macd';
UPDATE catalog_listings SET category = 'other'          WHERE slug = 'suverse-ta-moving-averages';
UPDATE catalog_listings SET category = 'other'          WHERE slug = 'suverse-ta-rsi';
UPDATE catalog_listings SET category = 'other'          WHERE slug = 'suverse-wallet-history';
