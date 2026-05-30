-- 014_catalog_slug_samples.sql — Catalog v2 fields.
--
-- Adds:
--   * `slug` — URL-friendly id derived from title. Public listing
--     URLs become /catalog/<slug> instead of /catalog/<uuid>; better
--     for SEO + share + memory. UNIQUE; auto-generated with a short
--     hash suffix to handle title collisions.
--   * `sample_request_curl` — curl one-liner the seller pastes in to
--     show buyers how to call the endpoint. Optional; used in the
--     listing detail page's "How to use" section.
--   * `sample_response_json` — example response body. Optional;
--     rendered as a syntax-highlighted code block on the detail page.
--   * Index on `slug` for lookup.
--
-- Backfill: every existing row needs a slug. The migration computes
-- one from the title + first 6 chars of the id as a uniqueness
-- suffix — guaranteed unique because the id itself is unique.

ALTER TABLE catalog_listings
  ADD COLUMN IF NOT EXISTS slug                 TEXT,
  ADD COLUMN IF NOT EXISTS sample_request_curl  TEXT,
  ADD COLUMN IF NOT EXISTS sample_response_json TEXT;

-- Backfill slugs for existing rows. Kept deliberately SQL-portable
-- (pg-mem ships very few text functions — no regexp_replace 4-arg
-- form, no substr). Pre-existing rows get the full id::text as their
-- slug, which is unique by definition. Acceptable degradation: in
-- prod this table is empty when migration runs. New rows go through
-- the JS `deriveSlug()` in catalog-store.ts which produces friendly
-- SEO slugs.
UPDATE catalog_listings
   SET slug = id::text
 WHERE slug IS NULL;

-- Now safe to require slug going forward + add the unique index.
-- (CHECK on text not enforced in the schema — application generates
-- the slug, this is just a uniqueness guard.)
ALTER TABLE catalog_listings
  ALTER COLUMN slug SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS catalog_listings_slug_idx
  ON catalog_listings (slug);
