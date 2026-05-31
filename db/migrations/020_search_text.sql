-- 020_search_text.sql — search_text TEXT column on the two row sources the
-- /api/search route unions (external_endpoints + seller_proxy_configs).
--
-- Maintained at write time: the catalog syncer's upsert (apps/api/src/
-- catalogs/upsert.ts) and the dashboard's seller-proxy create/edit path
-- compose `search_text = lower(description ' ' url ' ' slug ' ' …)` so
-- the route can do a single case-insensitive LIKE / ILIKE against one
-- indexed column rather than fanning out per-column.
--
-- pg-mem compat: we deliberately avoid GENERATED ALWAYS AS … STORED
-- (pg-mem 3.0.14 doesn't implement it) and avoid `CREATE EXTENSION
-- pg_trgm` + GIN/trgm indexes (likewise unsupported). The trgm index
-- is added by a follow-up production-only DDL applied out-of-band via
-- psql (see deploy/sql/021_search_trgm_index_prod.sql) so test
-- environments stay green. Plain LIKE is adequate at ≤40k rows; the
-- trgm index is only a nice-to-have for sub-millisecond search.

ALTER TABLE external_endpoints ADD COLUMN IF NOT EXISTS search_text TEXT;

UPDATE external_endpoints
   SET search_text = lower(coalesce(description, '') || ' ' || coalesce(resource_url, ''))
 WHERE search_text IS NULL;

ALTER TABLE seller_proxy_configs ADD COLUMN IF NOT EXISTS search_text TEXT;

UPDATE seller_proxy_configs
   SET search_text = lower(
           coalesce(display_name, '') || ' '
        || coalesce(description, '') || ' '
        || coalesce(endpoint_slug, '') || ' '
        || coalesce(public_slug, '')
       )
 WHERE search_text IS NULL;
