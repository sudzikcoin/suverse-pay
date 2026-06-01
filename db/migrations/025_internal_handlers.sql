-- 025_internal_handlers.sql — internal handler dispatch.
--
-- The proxy can now serve an endpoint from in-process code instead of
-- (or in addition to) an HTTP upstream. When `internal_handler` is set
-- on a `seller_proxy_configs` row, the proxy looks up that name in its
-- handler registry after settle and returns whatever the handler
-- produces — no `fetch()` to `original_url`, no `upstream_x402` path.
--
-- This is the foundation for "first-party" endpoints where SuVerse is
-- the actual service provider (Helius-backed Solana tx decoder, etc.)
-- rather than reselling someone else's 402-protected upstream.
--
-- The column is nullable + free-text: existing rows behave exactly as
-- before, and adding a new handler does not require another migration.
-- The runtime registry enumerates the legal names; an unknown value
-- surfaces as 503 invalid_config (logged with the offending name) so a
-- typo in this column cannot silently fall through to the upstream
-- path. `original_url` is still NOT NULL for back-compat — for an
-- internal-only endpoint, set it to the canonical proxy URL itself
-- (the value is unused at runtime but still surfaces in dashboards).

ALTER TABLE seller_proxy_configs
  ADD COLUMN IF NOT EXISTS internal_handler TEXT;
