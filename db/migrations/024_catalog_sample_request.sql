-- 024_catalog_sample_request.sql — sample_request_json on catalog_listings.
--
-- Body-method (POST/PUT/PATCH) endpoints need a request-body example
-- to emit a valid extensions.bazaar block. Without it, CDP Bazaar's
-- crawler skips the route (it requires `info.input.body` for body
-- methods, schema-validated). Until now the proxy only emitted
-- extensions for GET/DELETE since we had no place to store the
-- example body — fixed here.
--
-- Stored as TEXT to mirror sample_response_json; parsed at read time
-- in apps/proxy/src/store.ts. Existing rows stay NULL and remain
-- GET/DELETE-only (the current behavior), so the migration is
-- backwards compatible for every legacy listing.

ALTER TABLE catalog_listings
  ADD COLUMN IF NOT EXISTS sample_request_json TEXT;
