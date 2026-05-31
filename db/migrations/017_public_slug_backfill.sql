-- 017_public_slug_backfill.sql — backfill public_slug for the 9 production
-- proxy endpoints under reskey_1166628d, plus repoint their catalog rows at
-- the new /v1/data/<public_slug> URL.
--
-- Migration 016 added the public_slug column (nullable) and the
-- catalog_listings.proxy_config_id FK. This is the one-shot data move
-- that flips those 9 endpoints from the legacy /v1/proxy/<reskey>/<slug>
-- URLs (which CDP's Bazaar crawler filters as session-token-looking)
-- onto the clean /v1/data/<public_slug> URLs CDP indexes. The 8 + 1
-- batch was settled live on Base via CDP on 2026-05-31; 9/9 ended up
-- in `/discovery/merchant?payTo=0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0`
-- within ~25 min (one extra retry for `tvl` after a sample-response-json
-- shape fix — see CHANGELOG / IDEAS notes).
--
-- Idempotent: WHERE clauses guard against re-running on a DB that has
-- already been backfilled (only matches rows where public_slug is still
-- NULL AND the endpoint_slug is one of the original 9). Safe to apply
-- against any seed-data state.

UPDATE seller_proxy_configs SET public_slug = 'coingecko-btc-eth-prices', updated_at = now()
 WHERE resource_key_id = 'reskey_1166628d' AND endpoint_slug = 'prices'       AND public_slug IS NULL;
UPDATE seller_proxy_configs SET public_slug = 'defillama-tvl',            updated_at = now()
 WHERE resource_key_id = 'reskey_1166628d' AND endpoint_slug = 'tvl'          AND public_slug IS NULL;
UPDATE seller_proxy_configs SET public_slug = 'binance-btc-spot',         updated_at = now()
 WHERE resource_key_id = 'reskey_1166628d' AND endpoint_slug = 'btc-spot'     AND public_slug IS NULL;
UPDATE seller_proxy_configs SET public_slug = 'coinbase-btc-spot',        updated_at = now()
 WHERE resource_key_id = 'reskey_1166628d' AND endpoint_slug = 'coinbase-btc' AND public_slug IS NULL;
UPDATE seller_proxy_configs SET public_slug = 'geckoterminal-eth-pools',  updated_at = now()
 WHERE resource_key_id = 'reskey_1166628d' AND endpoint_slug = 'eth-pools'    AND public_slug IS NULL;
UPDATE seller_proxy_configs SET public_slug = 'weather-forecast-nyc',     updated_at = now()
 WHERE resource_key_id = 'reskey_1166628d' AND endpoint_slug = 'weather'      AND public_slug IS NULL;
UPDATE seller_proxy_configs SET public_slug = 'fiat-exchange-rates',      updated_at = now()
 WHERE resource_key_id = 'reskey_1166628d' AND endpoint_slug = 'forex'        AND public_slug IS NULL;
UPDATE seller_proxy_configs SET public_slug = 'ethereum-gas-tracker',     updated_at = now()
 WHERE resource_key_id = 'reskey_1166628d' AND endpoint_slug = 'eth-gas'      AND public_slug IS NULL;
UPDATE seller_proxy_configs SET public_slug = 'ip-geolocation',           updated_at = now()
 WHERE resource_key_id = 'reskey_1166628d' AND endpoint_slug = 'geo'          AND public_slug IS NULL;

-- Repoint each catalog_listings row at the new clean URL + bind the FK.
-- Matches rows that still point at the legacy /v1/proxy/.../<endpoint_slug>
-- shape AND have an unset proxy_config_id, so re-run is a no-op.
UPDATE catalog_listings cl
   SET proxy_config_id = spc.id,
       endpoint_url    = 'https://proxy.suverse.io/v1/data/' || spc.public_slug
  FROM seller_proxy_configs spc
 WHERE spc.resource_key_id = 'reskey_1166628d'
   AND spc.public_slug IS NOT NULL
   AND cl.endpoint_url = 'https://proxy.suverse.io/v1/proxy/reskey_1166628d/' || spc.endpoint_slug
   AND cl.proxy_config_id IS NULL;

-- DeFiLlama TVL sample_response_json was originally a bare JSON array
-- (`[{...},{...}]`). CDP's Bazaar schema for bazaar.info.output expects
-- example to be an `object` (not an array), so the entry was rejected
-- by the indexer. Wrap in `{"protocols": [...]}` so the example type
-- matches the schema. Idempotent: only updates rows that still hold the
-- array shape (jsonb_typeof = 'array').
UPDATE catalog_listings
   SET sample_response_json = jsonb_build_object('protocols', sample_response_json::jsonb)::text
 WHERE endpoint_url = 'https://proxy.suverse.io/v1/data/defillama-tvl'
   AND jsonb_typeof(sample_response_json::jsonb) = 'array';
