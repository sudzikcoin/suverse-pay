-- 016_public_slug.sql — globally-unique public_slug for /v1/data/<slug>
-- routing, plus an explicit FK from catalog_listings to seller_proxy_configs
-- so the bazaar lookup no longer needs the brittle split_part(URL, '/', -1)
-- JOIN constraint.
--
-- Motivation: CDP's Bazaar crawler filters /v1/proxy/<reskey_HEX>/<slug>
-- URLs (the long hex-like segment trips a session-token heuristic), so the
-- 9 self-serve proxy endpoints never appear in discovery. Routing the same
-- spc rows behind a clean /v1/data/<public_slug> URL on the same proxy
-- host clears the filter (proven by an 8-experiment series ending in
-- a 35-second indexing of proxy.suverse.io/v1/data/test-btc-spot-noresk).
--
-- Backward compat is Policy A: the legacy /v1/proxy/<reskey>/<slug> route
-- keeps working for existing buyers (e.g. AgentOS scripts). Only the
-- catalog/discovery surface advertises the /v1/data/ URL.

ALTER TABLE seller_proxy_configs
    ADD COLUMN public_slug TEXT;

-- Globally unique among non-NULL values. NULL means the endpoint is only
-- reachable via the legacy /v1/proxy/<reskey>/<endpoint_slug> URL — kept
-- nullable so existing rows don't need backfill before the column exists,
-- and new sellers can defer choosing a public slug.
CREATE UNIQUE INDEX seller_proxy_configs_public_slug_unique
    ON seller_proxy_configs (public_slug)
    WHERE public_slug IS NOT NULL;

-- Format validation (lowercase alphanumeric + hyphens, 3..50 chars, start
-- and end on an alphanumeric) is enforced at the application layer (the
-- dashboard's new-proxy form + a server-side admin check). We deliberately
-- DO NOT enforce it via a DB CHECK because the natural regex form uses
-- the POSIX `~` operator which pg-mem (the test infrastructure) does not
-- implement, and the test suites that run migrations against pg-mem would
-- break on apply. The UNIQUE index above still guarantees the slug is
-- globally unique among non-NULL values.

-- Explicit FK from a catalog row to the proxy config it describes. Replaces
-- the prior split_part(endpoint_url, '/', -1) = spc.endpoint_slug heuristic
-- in CatalogBazaarStore.lookup, which was about to break: under the new
-- /v1/data/<public_slug> URLs the last path segment is the public slug,
-- not the spc's endpoint_slug. SET NULL on delete so removing a proxy
-- config orphans the catalog row instead of cascading it away — admins
-- can then re-point or retire the listing manually.
ALTER TABLE catalog_listings
    ADD COLUMN proxy_config_id UUID
    REFERENCES seller_proxy_configs(id) ON DELETE SET NULL;

CREATE INDEX catalog_listings_proxy_config_id_idx
    ON catalog_listings (proxy_config_id)
    WHERE proxy_config_id IS NOT NULL;
