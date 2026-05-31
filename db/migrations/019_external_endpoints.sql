-- 019_external_endpoints.sql — mirror of every paid x402 endpoint we can
-- see from upstream discovery catalogs (CDP Bazaar + future sources).
-- Periodically refreshed by the `CatalogSyncer` in apps/api so the
-- unified-search surface (phase 3) reads the local mirror instead of
-- fanning out to every source on every query.
--
-- Dedup key is (resource_url, pay_to): the same endpoint can legitimately
-- appear in multiple catalogs. We keep `source` as the LAST writer (whichever
-- catalog refreshed it most recently). Per-row `archived_at` is set when a
-- previously-seen URL disappears from its source; we keep the row instead of
-- deleting so the search index can show "last seen 3 days ago" instead of a
-- hard 404.

-- id is supplied by the caller (crypto.randomUUID() in TS) — matches the
-- convention every other table in this schema uses (pg-mem doesn't register
-- gen_random_uuid by default, and DEFAULTing here would break db tests).
CREATE TABLE external_endpoints (
    id UUID PRIMARY KEY,
    source TEXT NOT NULL,                       -- 'cdp-bazaar', 'x402-org', ...
    resource_url TEXT NOT NULL,
    pay_to TEXT NOT NULL,
    x402_version INT,
    description TEXT,
    accepts JSONB NOT NULL,                     -- the accepts[] array as-is
    extensions JSONB,                           -- extensions.bazaar etc
    quality_signals JSONB,                      -- l30DaysTotalCalls etc (CDP)
    raw_payload JSONB,                          -- full source entry for diff/debug
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at TIMESTAMPTZ                     -- NULL = live in its source
);

CREATE UNIQUE INDEX external_endpoints_url_payto_unique
    ON external_endpoints (resource_url, pay_to);

CREATE INDEX external_endpoints_source_active_idx
    ON external_endpoints (source)
    WHERE archived_at IS NULL;

CREATE INDEX external_endpoints_last_seen_idx
    ON external_endpoints (last_seen_at DESC)
    WHERE archived_at IS NULL;

-- One-row sync-state table so /admin/catalog/stats can report per-source
-- last_run / last_count / last_status without scanning external_endpoints
-- twice. UPSERTed by the syncer at the end of each per-source pass.
CREATE TABLE external_catalog_runs (
    source TEXT PRIMARY KEY,
    last_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_status TEXT NOT NULL,                  -- 'ok', 'partial', 'error'
    last_error TEXT,
    last_fetched_count INT NOT NULL DEFAULT 0,
    last_upserted_count INT NOT NULL DEFAULT 0,
    last_archived_count INT NOT NULL DEFAULT 0,
    total_runs INT NOT NULL DEFAULT 0
);
