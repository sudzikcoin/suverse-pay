-- 021_search_trgm_index_prod.sql — PRODUCTION-ONLY DDL.
--
-- Applied out-of-band via psql, not by the @suverse-pay/db migration
-- runner, because (a) it depends on the pg_trgm contrib extension
-- (pg-mem doesn't implement) and (b) the CREATE INDEX … gin_trgm_ops
-- form is likewise unsupported by pg-mem. Including it in db/migrations/
-- would break db tests.
--
-- Apply manually on production before any code path that needs
-- sub-millisecond search across >>10k rows:
--   psql "$DATABASE_URL" -f deploy/sql/021_search_trgm_index_prod.sql
-- Safe to re-run: every statement uses IF NOT EXISTS.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS external_endpoints_search_trgm
    ON external_endpoints USING GIN (search_text gin_trgm_ops)
    WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS seller_proxy_configs_search_trgm
    ON seller_proxy_configs USING GIN (search_text gin_trgm_ops)
    WHERE is_active = true;
