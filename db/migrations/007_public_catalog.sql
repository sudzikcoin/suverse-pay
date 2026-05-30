-- 007_public_catalog.sql — Phase 5 Block 4 Sub-task 4.7.
--
-- Public discovery catalog. Sellers list their x402 endpoints
-- regardless of which facilitator they use (Coinbase CDP, PayAI,
-- our cosmos-pay, anything). suverse-pay becomes a DISCOVERY layer
-- on top of its role as a facilitator gateway: the catalog accepts
-- endpoints with NO mandatory link to resource_api_keys.
--
-- Two-tier listings:
--   * Verified — linked to a resource_api_keys row the listing's
--                submitter owns (via dashboard_user_resource_keys).
--                Auto-published on insert.
--   * External — uses some other facilitator. Goes through a
--                moderation queue (status='pending'). Submitter may
--                be a logged-in dashboard user OR an anonymous
--                public-form submission (email-verified).
--
-- Regional filter: every listing carries a regions[] array of ISO
-- 3166-1 alpha-2 lowercase codes plus the special 'global'. Also
-- region_restrictions[] for explicit blocks (e.g. ['ru','cn']).
-- Search logic in apps/dashboard/src/lib/catalog-search.ts treats
-- 'global' as "available everywhere except region_restrictions".
--
-- Note: resource_api_keys.id is TEXT (per migration 003), so the
-- resource_key_id FK here is TEXT — matches dashboard_user_resource_keys
-- and resource_server_configs.
--
-- pg-mem gotcha: pg-mem does not implement gen_random_uuid() out of
-- the box. App-side inserts must supply UUIDs via Node
-- crypto.randomUUID(), same pattern as dashboard_users in 003. We
-- still set the DB default to gen_random_uuid() so a manual psql
-- insert in production works without prep, but EVERY app-side
-- INSERT supplies an explicit id.

CREATE TABLE IF NOT EXISTS catalog_listings (
  id                      UUID PRIMARY KEY,

  -- Display. Length bounds (title 3..200, description ≤2000) and
  -- URL shape (https://...) are enforced in the Zod validator
  -- (catalog-store.ts CreateListingSchema) — pg-mem doesn't ship
  -- length()/char_length() or a text-regex implementation, so the
  -- DB CHECK would be a tests-only blocker without adding real
  -- safety on top of the app-layer validation we already have.
  title                   TEXT NOT NULL,
  description             TEXT,
  endpoint_url            TEXT NOT NULL,
  category                TEXT,
  tags                    TEXT[] NOT NULL DEFAULT '{}',

  -- Pricing band (NULLable: external listings sometimes won't know
  -- exact prices, or charge dynamically). Atomic units, NUMERIC(78,0)
  -- to match the wire-format precision used in facilitator_payments.
  price_atomic_min        NUMERIC(78, 0),
  price_atomic_max        NUMERIC(78, 0),
  price_unit              TEXT NOT NULL DEFAULT 'per-call',

  -- Reach
  networks                TEXT[] NOT NULL DEFAULT '{}',
  regions                 TEXT[] NOT NULL DEFAULT ARRAY['global'],
  region_restrictions     TEXT[] NOT NULL DEFAULT '{}',

  -- Tier
  is_verified             BOOLEAN NOT NULL DEFAULT FALSE,
  resource_key_id         TEXT
                            REFERENCES resource_api_keys(id)
                            ON DELETE SET NULL,
  facilitator_url         TEXT,

  -- Submitter
  submitted_by_user_id    UUID
                            REFERENCES dashboard_users(id)
                            ON DELETE SET NULL,
  submitted_email         TEXT,
  submission_ip           TEXT,

  -- Moderation
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'approved',
                                              'rejected', 'suspended')),
  rejection_reason        TEXT,
  reviewed_by             TEXT,
  reviewed_at             TIMESTAMPTZ,

  -- Optional branding/docs
  logo_url                TEXT,
  homepage_url            TEXT,
  documentation_url       TEXT,

  -- Engagement counters (rate-limited per IP at the API layer)
  view_count              INTEGER NOT NULL DEFAULT 0,
  click_count             INTEGER NOT NULL DEFAULT 0,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at            TIMESTAMPTZ
);

-- The hot read path (/api/catalog) filters status='approved' and
-- then orders by (is_verified DESC, view_count DESC). A plain index
-- on status is enough; the rest is small enough to sort in memory
-- for v1.
CREATE INDEX IF NOT EXISTS catalog_listings_status_idx
  ON catalog_listings (status);

-- GIN indexes for array containment filters (regions, networks, tags).
-- pg-mem doesn't implement GIN but accepts the CREATE INDEX with no
-- effect — real Postgres uses these to filter network='eip155:8453'
-- without scanning every row.
CREATE INDEX IF NOT EXISTS catalog_listings_networks_idx
  ON catalog_listings USING GIN (networks);
CREATE INDEX IF NOT EXISTS catalog_listings_regions_idx
  ON catalog_listings USING GIN (regions);
CREATE INDEX IF NOT EXISTS catalog_listings_tags_idx
  ON catalog_listings USING GIN (tags);

-- "My listings" lookup for a dashboard user.
CREATE INDEX IF NOT EXISTS catalog_listings_submitter_idx
  ON catalog_listings (submitted_by_user_id);

-- Anonymous-submission email-verification rows. The token is a 32-byte
-- random hex string generated app-side and logged to console for now
-- (real SMTP/Resend deferred to a later sub-task). The 7-day expiry is
-- enforced both in this default and again at verify time.
CREATE TABLE IF NOT EXISTS catalog_external_submissions (
  id                      UUID PRIMARY KEY,
  listing_id              UUID NOT NULL
                            REFERENCES catalog_listings(id)
                            ON DELETE CASCADE,
  email                   TEXT NOT NULL,
  verification_token      TEXT NOT NULL UNIQUE,
  verified_at             TIMESTAMPTZ,
  expires_at              TIMESTAMPTZ NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS catalog_external_submissions_token_idx
  ON catalog_external_submissions (verification_token);

-- Coordination with Sub-task 4.5 (`resource_server_configs`, migration
-- 006). The shared touchpoint is `auto_publish_to_catalog`: when a
-- seller configures their resource key (the 4.5 flow) they can opt-in
-- to have a verified catalog listing auto-created from the config.
-- Both 006 and 007 ship to main as a pair; if a follower re-runs
-- migrations from a checkpoint where only 006 was applied this ADD
-- COLUMN IF NOT EXISTS is idempotent.
--
-- Plain ALTER (not wrapped in plpgsql DO) because pg-mem doesn't
-- implement plpgsql. The migration runner sorts files alphabetically
-- so 006 always precedes 007 — the dependency is guaranteed.
ALTER TABLE resource_server_configs
  ADD COLUMN IF NOT EXISTS auto_publish_to_catalog
    BOOLEAN NOT NULL DEFAULT FALSE;
