-- 018_drop_public_slug_format_check.sql — drop the public_slug regex
-- CHECK that migration 016 originally shipped with. The CHECK used the
-- POSIX `~` operator which pg-mem does not implement, so fresh test
-- environments could not apply 016. Migration 016 has now been amended
-- to omit the CHECK; this migration removes it from already-applied
-- production databases so the schema is consistent across all
-- environments.
--
-- Format validation (lowercase, alphanumeric + hyphens, 3..50 chars)
-- lives in the application layer instead (dashboard new-proxy form +
-- server-side admin check). The UNIQUE index from 016 still guarantees
-- global uniqueness.

ALTER TABLE seller_proxy_configs
    DROP CONSTRAINT IF EXISTS seller_proxy_configs_public_slug_format;
