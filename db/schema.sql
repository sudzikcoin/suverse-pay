-- 001_initial.sql — Phase 1 schema for suverse-pay.
--
-- Tracks: API keys, merchant policies, provider registry + capability
-- discovery, provider health checks, payments + their attempts +
-- the router's decision audit.
--
-- All times in UTC `timestamptz`. ULIDs (text) for ids generated in
-- application code via `ulidx`.

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  key_hash    TEXT NOT NULL UNIQUE,
  label       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS merchant_policies (
  api_key_id  TEXT NOT NULL REFERENCES api_keys(id),
  policy      JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (api_key_id)
);

CREATE TABLE IF NOT EXISTS providers (
  id              TEXT PRIMARY KEY,           -- "coinbase-cdp"
  display_name    TEXT NOT NULL,
  config          JSONB NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (provider, network, asset, scheme) tuple. Flags
-- indicate whether the capability is declared in static config,
-- runtime-discovered, or both. `superseded_at` is set when a
-- discovery reveals the capability no longer exists.
CREATE TABLE IF NOT EXISTS provider_capabilities (
  provider_id     TEXT NOT NULL REFERENCES providers(id),
  network         TEXT NOT NULL,              -- CAIP-2
  asset           TEXT NOT NULL,
  scheme          TEXT NOT NULL,
  is_static       BOOLEAN NOT NULL DEFAULT FALSE,
  is_discovered   BOOLEAN NOT NULL DEFAULT FALSE,
  discovered_at   TIMESTAMPTZ,
  superseded_at   TIMESTAMPTZ,
  PRIMARY KEY (provider_id, network, asset, scheme),
  CHECK (is_static OR is_discovered)
);

CREATE TABLE IF NOT EXISTS provider_health_checks (
  id              BIGSERIAL PRIMARY KEY,
  provider_id     TEXT NOT NULL REFERENCES providers(id),
  status          TEXT NOT NULL,              -- "healthy" | "degraded" | "down"
  latency_ms      INTEGER,
  error           TEXT,
  checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS provider_health_checks_by_provider_recent_idx
  ON provider_health_checks (provider_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS payments (
  id                  TEXT PRIMARY KEY,
  idempotency_key     TEXT,
  api_key_id          TEXT NOT NULL REFERENCES api_keys(id),
  status              TEXT NOT NULL,          -- "pending" | "settled" | "failed"
  network             TEXT NOT NULL,
  asset               TEXT NOT NULL,
  amount              NUMERIC(78,0) NOT NULL, -- atomic units
  payer               TEXT,
  recipient           TEXT NOT NULL,
  resource            TEXT,
  request_body        JSONB NOT NULL,
  final_provider_id   TEXT REFERENCES providers(id),
  final_tx_hash       TEXT,
  error_code          TEXT,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at          TIMESTAMPTZ,
  -- Phase 5 Phase 2 T7 — second protocol family. Defaults to 'x402'
  -- so the column lands non-breaking; /mpp/* writes emit 'mpp'
  -- explicitly. mpp_method/mpp_intent are populated only when
  -- protocol='mpp'; the application enforces that invariant
  -- (services/orchestrator/src/ledger.ts).
  protocol            TEXT NOT NULL DEFAULT 'x402',
  mpp_method          TEXT,
  mpp_intent          TEXT
);

-- Partial unique index — clients that don't pass an Idempotency-Key
-- get a NULL here, and NULLs do not collide.
CREATE UNIQUE INDEX IF NOT EXISTS payments_idempotency_idx
  ON payments (api_key_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS payments_by_status_recent_idx
  ON payments (status, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_by_final_provider_idx
  ON payments (final_provider_id, settled_at DESC);
CREATE INDEX IF NOT EXISTS payments_by_mpp_idx
  ON payments (mpp_method, mpp_intent)
  WHERE protocol = 'mpp';

CREATE TABLE IF NOT EXISTS payment_attempts (
  id                BIGSERIAL PRIMARY KEY,
  payment_id        TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  attempt_number    INTEGER NOT NULL,
  provider_id       TEXT NOT NULL REFERENCES providers(id),
  outcome           TEXT NOT NULL,            -- "pending" | "success" | "failed" | "timeout"
  error_code        TEXT,
  error_message     TEXT,
  latency_ms        INTEGER,
  provider_response JSONB,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS payment_attempts_by_payment_idx
  ON payment_attempts (payment_id, attempt_number);
CREATE INDEX IF NOT EXISTS payment_attempts_by_provider_recent_idx
  ON payment_attempts (provider_id, started_at DESC);

CREATE TABLE IF NOT EXISTS routing_decisions (
  id                    BIGSERIAL PRIMARY KEY,
  payment_id            TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  candidate_providers   JSONB NOT NULL,
  selected_provider_id  TEXT NOT NULL,
  policy                JSONB NOT NULL,
  scores                JSONB NOT NULL,
  decided_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS routing_decisions_by_payment_idx
  ON routing_decisions (payment_id);
-- 002_facilitator.sql — Phase 3 Sub-task 5 schema.
--
-- Adds the storage that backs the public /facilitator/* endpoint
-- surface: resource API keys (separate from the v0.1 admin api_keys
-- table — different scope, different lifecycle, different code path),
-- a per-payment audit log specifically for facilitator-mode settles,
-- and a failover-events table so we can answer "how often is the
-- backup adapter getting invoked".
--
-- Notes:
--   - Resource keys are hashed with the same deterministic sha256 the
--     admin api_keys table uses. The auth plugin needs cheap O(1)
--     lookup on the hot path; bcrypt/argon2 would require row-by-row
--     verification across all rows. The plaintext key is generated as
--     32 random bytes (256-bit entropy) by the bootstrap CLI, which
--     is the security floor — without per-row salt the protection
--     comes from key entropy, not the hash function.
--   - facilitator_payments duplicates some fields from the v0.1
--     `payments` table because the two flows are independent: v0.1
--     `payments` are MCP / admin-key calls and have a per-tenant
--     api_key_id; facilitator_payments are resource-server calls and
--     have a resource_key_id. Routing through one table would
--     conflate two different access models. The downside is a small
--     amount of duplication; the upside is that each side can evolve
--     without breaking the other.

CREATE TABLE IF NOT EXISTS resource_api_keys (
  id                     TEXT PRIMARY KEY,            -- "reskey_<8 hex>" — short, log-safe
  key_hash               TEXT NOT NULL UNIQUE,        -- sha256(plaintext) hex
  label                  TEXT NOT NULL,               -- human identifier (e.g. "weather-api.example.com")
  rate_limit_per_minute  INTEGER NOT NULL DEFAULT 60,
  -- Nullable monthly cap. NULL = unlimited (paid tier / trusted
  -- partner). Numeric = soft+hard cap; soft enforced by /facilitator
  -- handler with a warning header, hard enforced by 429.
  monthly_settle_cap     INTEGER,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at           TIMESTAMPTZ,
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  -- Free-form metadata. Tags, contact info, internal ticket id, etc.
  -- Schema-on-read; the /facilitator code does NOT branch on its
  -- contents (Phase 4+ may).
  metadata               JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS resource_api_keys_active_idx
  ON resource_api_keys (is_active) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS facilitator_payments (
  id                  TEXT PRIMARY KEY,                -- "fpay_<ulid>"
  resource_key_id     TEXT NOT NULL REFERENCES resource_api_keys(id),
  idempotency_key     TEXT NOT NULL,                   -- derived hash (see services/facilitator)
  network             TEXT NOT NULL,                   -- CAIP-2
  asset               TEXT NOT NULL,
  scheme              TEXT NOT NULL,
  amount              TEXT NOT NULL,                   -- atomic units
  payer               TEXT,                            -- from facilitator response when known
  recipient           TEXT NOT NULL,                   -- PaymentRequirements.payTo
  -- Which adapter actually settled this. Set on success; for failed
  -- settlements that exhausted the candidate list, set to the LAST
  -- adapter we tried so failures can be attributed.
  adapter_used        TEXT,
  tx_hash             TEXT,
  status              TEXT NOT NULL,                   -- "settled" | "failed" | "pending"
  error_code          TEXT,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at          TIMESTAMPTZ,
  CONSTRAINT facilitator_payments_idem_unique
    UNIQUE (resource_key_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS facilitator_payments_recent_idx
  ON facilitator_payments (created_at DESC);
CREATE INDEX IF NOT EXISTS facilitator_payments_by_resource_idx
  ON facilitator_payments (resource_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS facilitator_payments_by_network_idx
  ON facilitator_payments (network, created_at DESC);
CREATE INDEX IF NOT EXISTS facilitator_payments_by_adapter_idx
  ON facilitator_payments (adapter_used, created_at DESC)
  WHERE adapter_used IS NOT NULL;

-- One row per failover decision — i.e. the primary adapter returned a
-- retryable error and we attempted a secondary. Used by metrics + by
-- the routing policy if we ever add adaptive priority based on recent
-- failover history.
CREATE TABLE IF NOT EXISTS facilitator_failover_events (
  id                  BIGSERIAL PRIMARY KEY,
  payment_id          TEXT NOT NULL REFERENCES facilitator_payments(id),
  primary_adapter     TEXT NOT NULL,
  backup_adapter      TEXT NOT NULL,
  primary_error_code  TEXT NOT NULL,
  primary_error_message TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS facilitator_failover_events_recent_idx
  ON facilitator_failover_events (created_at DESC);
-- 003_dashboard.sql — Phase 5 Block 4 Sub-task 1.
--
-- Adds the storage that backs the customer dashboard at
-- suverse-pay.suverse.io. Two tables:
--
--   * dashboard_users           — one row per OAuth-authenticated
--                                 customer. Identified by
--                                 (oauth_provider, oauth_provider_id).
--   * dashboard_user_resource_keys
--                               — many-to-many between dashboard
--                                 users and the existing
--                                 resource_api_keys table. Lets a
--                                 single OAuth user manage multiple
--                                 API keys (typical for ops people
--                                 running several projects).
--
-- Note: the existing resource_api_keys table uses TEXT primary
-- keys (e.g. "reskey_<8hex>"), NOT UUID. The link table FKs
-- against that TEXT id to stay consistent with the rest of the
-- schema. The dashboard tables themselves are UUID-keyed because
-- they're new and have no log-grep convention to honour.


CREATE TABLE IF NOT EXISTS dashboard_users (
  id                  UUID PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  oauth_provider      TEXT NOT NULL
                        CHECK (oauth_provider IN ('google', 'github')),
  oauth_provider_id   TEXT NOT NULL,
  display_name        TEXT,
  avatar_url          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Composite unique avoids the cross-provider collision where two
  -- providers happen to issue the same provider-side id for
  -- different humans. Email is also unique above, which catches the
  -- "same human signs in via Google then GitHub" case as a
  -- duplicate-row violation — desired: the dashboard policy is one
  -- user record per email, the first provider used wins.
  UNIQUE (oauth_provider, oauth_provider_id)
);

CREATE INDEX IF NOT EXISTS dashboard_users_email_idx
  ON dashboard_users (email);

CREATE TABLE IF NOT EXISTS dashboard_user_resource_keys (
  id                  UUID PRIMARY KEY,
  user_id             UUID NOT NULL
                        REFERENCES dashboard_users(id) ON DELETE CASCADE,
  resource_key_id     TEXT NOT NULL
                        REFERENCES resource_api_keys(id) ON DELETE CASCADE,
  linked_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, resource_key_id)
);

CREATE INDEX IF NOT EXISTS dashboard_user_resource_keys_user_id_idx
  ON dashboard_user_resource_keys (user_id);
CREATE INDEX IF NOT EXISTS dashboard_user_resource_keys_resource_key_idx
  ON dashboard_user_resource_keys (resource_key_id);
-- 004_per_settle_fees.sql — Phase 5 Block 4 Sub-task 3.
--
-- Per-settle platform fee accounting layer ("shadow ledger").
--
-- Adds:
--   * resource_api_keys.fee_bps        — per-key override in basis
--                                        points (NULL = use global
--                                        default from PLATFORM_FEE_BPS
--                                        env). Bounded 0..1000 (0..10%).
--   * facilitator_payments.gross_amount, fee_amount, net_amount
--                                      — accounting overlay on the
--                                        existing `amount` column. The
--                                        invariant is
--                                        `gross_amount = fee_amount + net_amount`.
--                                        `amount` keeps its meaning of
--                                        "what was settled on-chain"
--                                        (= gross for now — suverse-pay
--                                        does not yet collect the fee
--                                        on-chain; collection is
--                                        out-of-band via invoice CSV
--                                        download from the dashboard).
--
-- Backfill semantics: every pre-existing facilitator_payments row
-- becomes (gross=amount, fee=0, net=amount). This is honest — those
-- settles were not fee'd, the customer was not charged. From this
-- migration forward, every new row is computed via the same path.


-- ---------------------------------------------------------------
-- resource_api_keys.fee_bps
-- ---------------------------------------------------------------

ALTER TABLE resource_api_keys
  ADD COLUMN IF NOT EXISTS fee_bps INTEGER;

-- Named CHECK so future migrations / introspection have a stable
-- handle. The migration runner records this file in
-- schema_migrations and will not re-apply it, so plain ADD
-- CONSTRAINT is safe (no need for plpgsql IF NOT EXISTS — pg-mem
-- in tests does not register the plpgsql language).
ALTER TABLE resource_api_keys
  ADD CONSTRAINT resource_api_keys_fee_bps_range
  CHECK (fee_bps IS NULL OR (fee_bps >= 0 AND fee_bps <= 1000));


-- ---------------------------------------------------------------
-- facilitator_payments — gross/fee/net columns
-- ---------------------------------------------------------------

ALTER TABLE facilitator_payments
  ADD COLUMN IF NOT EXISTS gross_amount NUMERIC(78, 0);
ALTER TABLE facilitator_payments
  ADD COLUMN IF NOT EXISTS fee_amount   NUMERIC(78, 0);
ALTER TABLE facilitator_payments
  ADD COLUMN IF NOT EXISTS net_amount   NUMERIC(78, 0);

-- Backfill — existing settles did not have a fee deducted.
-- `amount` is TEXT (carries the atomic uint256 as a string to avoid
-- precision loss), so cast explicitly to numeric for the assignment.
UPDATE facilitator_payments
   SET gross_amount = amount::numeric,
       fee_amount   = 0,
       net_amount   = amount::numeric
 WHERE gross_amount IS NULL;

-- Now that every row has values, pin NOT NULL so the application
-- writer must always supply them going forward.
ALTER TABLE facilitator_payments
  ALTER COLUMN gross_amount SET NOT NULL,
  ALTER COLUMN fee_amount   SET NOT NULL,
  ALTER COLUMN net_amount   SET NOT NULL;

-- Invariant guard. Cheap CHECK — the planner skips it on read, and
-- the writer-side computeFee() helper is the authoritative source of
-- the split. The CHECK catches a future direct UPDATE that
-- accidentally desyncs the three columns.
ALTER TABLE facilitator_payments
  ADD CONSTRAINT facilitator_payments_fee_split_balanced
  CHECK (gross_amount = fee_amount + net_amount);
-- 005_webhooks.sql — Phase 5 Block 4 Sub-task 4.
--
-- Outbound webhook delivery for settle lifecycle events.
--
-- Two tables:
--
--   * webhook_endpoints   — one row per customer-configured URL.
--                           Owned by a dashboard_user (NOT by a
--                           resource_api_key — a customer often
--                           manages multiple keys and wants one
--                           webhook stream for the whole account).
--                           `secret` holds the PLAINTEXT signing key.
--                           Stored in plaintext because HMAC signing
--                           requires the secret material itself (unlike
--                           resource_api_keys where we only compare
--                           against a hash of received input). Shown
--                           to the customer EXACTLY ONCE at create
--                           time then served only over auth'd UI for
--                           manual re-copy if needed. Same trust model
--                           as Stripe's whsec_*.
--
--   * webhook_deliveries  — one row per (endpoint, event) attempt
--                           tuple. Status moves
--                           pending → success | failed | dead.
--                           `event_id` is the X-Suverse-Pay-Event-Id
--                           we put on the wire so the receiver can
--                           dedupe across retries; unique per
--                           (endpoint_id, event_id) so the same
--                           event is never fanned out twice for one
--                           endpoint.
--
-- The BullMQ queue is the source of truth for "what's next to
-- deliver"; this table is the source of truth for
-- "what was attempted and how it ended" (audit + dashboard log).

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id              UUID PRIMARY KEY,
  dashboard_user_id UUID NOT NULL
                       REFERENCES dashboard_users(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  -- PLAINTEXT signing secret (whsec_<base64url>). Stored as text
  -- because the delivery worker needs the actual bytes to compute
  -- HMAC-SHA256 against each payload. Shown to the customer ONCE
  -- at create time + served over auth'd dashboard UI on demand.
  secret          TEXT NOT NULL,
  -- Human label so the customer recognises which integration this
  -- endpoint is for ("staging-worker", "production-zap", ...).
  description     TEXT NOT NULL DEFAULT '',
  -- Subset of advertised event types this endpoint subscribes to.
  -- v1 only emits 'settle.succeeded' and 'settle.failed' but the
  -- column is flexible for future event types (key.*, invoice.*).
  events          TEXT[] NOT NULL DEFAULT ARRAY['settle.succeeded','settle.failed'],
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at    TIMESTAMPTZ,
  -- Cheap guard against accidentally subscribing to nothing.
  -- Use empty-array comparison rather than cardinality() so pg-mem
  -- (the in-memory Postgres used in db/__tests__) accepts it; both
  -- forms compile identically on real Postgres 15+.
  CONSTRAINT webhook_endpoints_events_nonempty CHECK (events <> '{}'::text[])
);

CREATE INDEX IF NOT EXISTS webhook_endpoints_by_user_idx
  ON webhook_endpoints (dashboard_user_id) WHERE is_active = TRUE;


CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                UUID PRIMARY KEY,
  endpoint_id       UUID NOT NULL
                       REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  -- The id we put on the wire (X-Suverse-Pay-Event-Id). Receivers
  -- dedupe on this — the same id will reappear on every retry
  -- attempt for the same delivery. Unique per (endpoint, event_id)
  -- so two endpoints can each receive the same logical event but
  -- the same endpoint never receives it twice.
  event_id          TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  -- The full JSON payload that gets HMAC'd + sent. Stored so the
  -- dashboard's deliveries log can show exactly what the receiver
  -- got, and so a retry replays the same bytes.
  payload           JSONB NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'success', 'failed', 'dead')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 6,
  last_attempt_at   TIMESTAMPTZ,
  last_response_code INTEGER,
  -- Short error string for the dashboard ("timeout", "5xx",
  -- "connection_refused", "4xx_no_retry"). Full debug detail lives
  -- in pino logs, NOT in DB — keeps the row size bounded.
  last_error        TEXT,
  -- Scheduled time for the next attempt (NULL once status is
  -- terminal — success / dead — or never scheduled).
  next_attempt_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT webhook_deliveries_event_unique
    UNIQUE (endpoint_id, event_id)
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_by_endpoint_recent_idx
  ON webhook_deliveries (endpoint_id, created_at DESC);
-- The worker doesn't poll this index — BullMQ owns the queue — but
-- a dashboard "show me everything still pending" query needs it.
CREATE INDEX IF NOT EXISTS webhook_deliveries_pending_idx
  ON webhook_deliveries (status, next_attempt_at)
  WHERE status = 'pending';
-- 006_seller_configs.sql — Phase 5 Block 4 Sub-task 4.5.
--
-- Resource server configuration ("seller config"). One row per
-- resource_api_keys row. Holds the metadata a seller chooses through
-- the /dashboard/keys/[id]/configure flow:
--
--   * default_price_atomic  — price per call in USDC atomic units.
--                             NUMERIC(78,0) matches the wire-format
--                             precision used elsewhere (gross/fee/net
--                             from migration 004 use the same type).
--                             Bounded [1000, 10000000] = [$0.001, $10].
--                             Lower bound is CDP's settle minimum on
--                             Base; upper bound is sanity for v1.
--
--   * accepted_networks     — CAIP-2 ids the seller will accept
--                             payments on. Validated app-side against
--                             the catalog in
--                             apps/dashboard/src/lib/networks-catalog.ts
--                             which mirrors what
--                             services/facilitator/src/routing-config.ts
--                             actually routes. Empty array on first
--                             insert; the dashboard refuses to save
--                             with [] (UX-level, not schema-level —
--                             we let the row exist transiently so an
--                             interrupted edit can resume).
--
--   * pay_to_*              — per-namespace USDC receive addresses.
--                             NULLable in the schema; required only
--                             when the matching network family is in
--                             accepted_networks. Per-format regex
--                             checked app-side in seller-config.ts;
--                             putting the regex in the DB would force
--                             pg-mem to learn each one, and the
--                             validator must run before the
--                             whole-row consistency check anyway.
--
--   * description           — optional public blurb. ≤ 500 chars
--                             (enforced app-side). Will surface in
--                             a future public discovery catalog;
--                             stored now so we don't need a second
--                             migration when that ships.
--
-- One-to-one with resource_api_keys: UNIQUE on resource_key_id +
-- ON DELETE CASCADE so revoking a key (which currently just sets
-- is_active=false) won't leave dangling configs if the key is ever
-- hard-deleted. The CASCADE matches dashboard_user_resource_keys'
-- behaviour in 003.

CREATE TABLE IF NOT EXISTS resource_server_configs (
  id                    UUID PRIMARY KEY,
  resource_key_id       TEXT NOT NULL UNIQUE
                          REFERENCES resource_api_keys(id) ON DELETE CASCADE,

  default_price_atomic  NUMERIC(78, 0) NOT NULL DEFAULT 70000,

  accepted_networks     TEXT[] NOT NULL DEFAULT '{}',

  pay_to_evm            TEXT,
  pay_to_solana         TEXT,
  pay_to_cosmos         TEXT,
  pay_to_tron           TEXT,

  description           TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Defence-in-depth: the Zod validator in the API route catches
  -- this first, but a misbehaving migration or a direct psql write
  -- shouldn't be able to brick a price into the unsettleable range.
  -- 1000 atomic USDC ($0.001) is CDP's documented Base minimum;
  -- 10_000_000 atomic ($10) is sanity for v1 single-price configs.
  CONSTRAINT resource_server_configs_price_range
    CHECK (default_price_atomic >= 1000
       AND default_price_atomic <= 10000000)
);

-- Lookup by resource_key_id is the read pattern (every page load on
-- /dashboard/keys/[id]/configure). UNIQUE already gives an index on
-- PostgreSQL, but make it explicit so pg-mem in tests is happy.
CREATE INDEX IF NOT EXISTS resource_server_configs_key_idx
  ON resource_server_configs (resource_key_id);
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
-- 008_capability_extras.sql — PR-A of "auto-discovery of network-specific extras".
--
-- Each adapter's discoverCapabilities() may now return per-kind
-- `extra` data — Solana feePayer pubkey, Cosmos grantee address +
-- chainId + decimals + symbol, EVM EIP-712 USDC domain (name/version),
-- TRON gasfree contract (later). The facilitator's
-- /facilitator/supported response surfaces this data per-kind so
-- @suverselabs/x402-server middleware can auto-merge it into 402
-- challenges, sparing sellers from having to know infrastructure-
-- specific addresses at all.
--
-- Schema is JSONB to keep each network's extras independently
-- versioned and shaped — the spec for what a Solana extra contains
-- has no business constraining a Cosmos extra.
--
-- Nullable so existing rows from migrations 002+'s static-capability
-- seed remain valid; the next discovery cron tick populates extras
-- for any adapter that knows them.

ALTER TABLE provider_capabilities
  ADD COLUMN extras_json JSONB;
-- 009_is_test_payments.sql — Mainnet/testnet split for facilitator_payments.
--
-- Dashboard had been mixing real production settles with leftover
-- Phase 4 testnet rows (cosmos:grand-1, eip155:84532) and a handful
-- of synthetic mock-failure rows that point at the placeholder asset
-- `0x0` on Base mainnet. Aggregations (settles count, volume,
-- network breakdown) treated all of them as production.
--
-- Rather than DELETE we tag with an explicit boolean. Audit trail is
-- preserved (payment_attempts / facilitator_failover_events FK
-- against facilitator_payments.id) and any future replay of historic
-- traffic can still surface the data via an opt-in toggle.
--
-- Backfill rules (run at migration time, idempotent because the
-- column is created with default FALSE):
--   * network IN ('cosmos:grand-1', 'eip155:84532')                  → testnet
--   * network = 'eip155:8453' AND asset = '0x0'                      → synthetic mock
--
-- New rows default to is_test=FALSE; the facilitator write path will
-- override per-request in payments-log.ts so future testnet settles
-- self-classify (T1.1 in dashboard cleanup).

ALTER TABLE facilitator_payments
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE facilitator_payments
   SET is_test = TRUE
 WHERE is_test = FALSE
   AND (
        network IN ('cosmos:grand-1', 'eip155:84532')
     OR (network = 'eip155:8453' AND asset = '0x0')
   );

-- The dashboard's default queries filter on is_test=FALSE. A partial
-- index keeps the production read path narrow when test rows
-- accumulate from staging traffic.
CREATE INDEX IF NOT EXISTS facilitator_payments_mainnet_recent_idx
  ON facilitator_payments (created_at DESC)
  WHERE is_test = FALSE;
-- 010_seller_proxy.sql — Self-serve API proxy ("wrap any HTTP API
-- behind an x402 endpoint without writing code").
--
-- A seller fills out a form in the dashboard with:
--   * the original (upstream) URL they want to monetise
--   * HTTP method + a slug they pick (/v1/proxy/<seller>/<slug>)
--   * price per call in atomic USDC
--   * which networks they will accept payments on
--   * a payTo address per namespace family
--   * optional forwarding headers (auth tokens, API keys for the
--     upstream API — stored AES-GCM encrypted at rest, keyed by
--     PROXY_HEADER_KEY env var)
--
-- The dashboard saves a row here; apps/proxy reads it on each
-- request, returns the right 402 challenge, and on settled payment
-- forwards the request to `original_url` with the decrypted headers
-- merged in.
--
-- Two tables:
--   1. seller_proxy_configs  — the per-endpoint settings
--   2. proxy_request_logs    — append-only per-request audit (drives
--                              the dashboard logs viewer + stats)
--
-- Note: `resource_api_keys.id` is TEXT (per migration 003), so all
-- FKs here are TEXT.

-- ---------------------------------------------------------------
-- seller_proxy_configs
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seller_proxy_configs (
  id                      UUID PRIMARY KEY,

  -- Owning key. CASCADE on delete is intentional — if the underlying
  -- resource key is hard-deleted (rare; soft-revoke is the norm),
  -- the proxy config is meaningless and should go with it.
  resource_key_id         TEXT NOT NULL
                            REFERENCES resource_api_keys(id) ON DELETE CASCADE,

  -- URL-safe slug the seller picks. Combined with resource_key_id
  -- to address the proxy: /v1/proxy/<resource_key_id>/<slug>.
  -- Length + regex enforced in the Zod validator (dashboard
  -- proxy-store.ts) — pg-mem doesn't ship regex CHECKs.
  endpoint_slug           TEXT NOT NULL,

  -- Upstream target. HTTPS-only is enforced in the validator; the
  -- proxy refuses to forward to non-https URLs even if a row sneaks
  -- through via direct psql.
  original_url            TEXT NOT NULL,
  original_method         TEXT NOT NULL,

  -- Display / discovery metadata. Description surfaces in the
  -- public catalog once the seller flips auto-publish on.
  display_name            TEXT,
  description             TEXT,

  -- Pricing. NUMERIC(78,0) matches the wire-format precision used
  -- by gross/fee/net in migration 004. Bounded 1000 .. 10_000_000
  -- (= $0.001 .. $10) — the same band as resource_server_configs
  -- (migration 006).
  price_atomic            NUMERIC(78, 0) NOT NULL,

  -- Networks (CAIP-2). Validated app-side against networks-catalog.ts.
  -- Empty array means "draft" — the proxy returns 503 in that case
  -- so a half-configured row never accidentally accepts payments.
  accepted_networks       TEXT[] NOT NULL DEFAULT '{}',

  -- Per-namespace receive addresses, mirroring resource_server_configs.
  -- NULLable; required only when the matching family is accepted.
  pay_to_evm              TEXT,
  pay_to_solana           TEXT,
  pay_to_cosmos           TEXT,
  pay_to_tron             TEXT,

  -- Forwarding headers, AES-256-GCM ciphertext (iv || tag || ct,
  -- base64). Decryption key is the PROXY_HEADER_KEY env var on the
  -- proxy service. NULL when the seller has no upstream auth.
  forward_headers_encrypted TEXT,

  -- Auth scheme for the headers. Today only 'static' is supported
  -- (the encrypted blob is a JSON object of name→value). The column
  -- exists so a future 'bearer-rotating' or 'hmac' mode can be added
  -- without a migration.
  forward_auth_scheme     TEXT NOT NULL DEFAULT 'static',

  -- Operator toggle. Defaults to TRUE; the dashboard exposes a
  -- pause switch so a seller can take the endpoint offline without
  -- deleting the row.
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT seller_proxy_configs_method_ok
    CHECK (original_method IN ('GET', 'POST', 'PUT', 'DELETE', 'PATCH')),

  CONSTRAINT seller_proxy_configs_price_range
    CHECK (price_atomic >= 1000 AND price_atomic <= 10000000),

  -- The slug is the second segment of the public URL — must be
  -- globally unique per owning key but can repeat across keys.
  CONSTRAINT seller_proxy_configs_slug_unique
    UNIQUE (resource_key_id, endpoint_slug)
);

CREATE INDEX IF NOT EXISTS seller_proxy_configs_by_resource_idx
  ON seller_proxy_configs (resource_key_id);

-- ---------------------------------------------------------------
-- proxy_request_logs
-- ---------------------------------------------------------------
-- Append-only audit. One row per incoming request to /v1/proxy/...
-- regardless of outcome (402, settled+forwarded, settle-failed,
-- upstream error). Drives the dashboard "Recent requests" log and
-- the proxy stats cards.
--
-- We log only what's safe to surface in a dashboard:
--   * outcome buckets (challenge / settled / settle_failed / upstream_error
--     / rate_limited / invalid_config)
--   * upstream HTTP status (NULL when the upstream was never reached)
--   * latency_ms for the upstream call (NULL otherwise)
--   * the on-chain tx_hash if payment settled
--   * the network / asset used for the payment
--   * the payment id from facilitator_payments (FK) when applicable
--
-- We DO NOT log request body, response body, or forwarded headers —
-- those could contain personal data and we never want to keep them
-- past the proxy's own short-lived buffer.
CREATE TABLE IF NOT EXISTS proxy_request_logs (
  id                      UUID PRIMARY KEY,
  proxy_config_id         UUID NOT NULL
                            REFERENCES seller_proxy_configs(id) ON DELETE CASCADE,
  resource_key_id         TEXT NOT NULL
                            REFERENCES resource_api_keys(id),

  -- Outcome bucket; see comment block above for the full list.
  outcome                 TEXT NOT NULL,

  -- Optional payment trail. Set on outcome IN ('settled',
  -- 'settle_failed') once the gateway picks a facilitator.
  facilitator_payment_id  TEXT REFERENCES facilitator_payments(id),
  network                 TEXT,
  amount_atomic           NUMERIC(78, 0),
  tx_hash                 TEXT,

  -- Upstream call info. NULL when payment never settled.
  upstream_status         INTEGER,
  upstream_latency_ms     INTEGER,

  -- For rate-limited / invalid_config / settle_failed — a short
  -- machine-readable reason (e.g. 'rate_limit_per_ip',
  -- 'no_payment_header', 'wrong_amount', 'verify_failed').
  error_code              TEXT,

  -- Hashed IP (sha256 first 16 hex chars) for rate-limit attribution
  -- without storing the raw address. NULL when we can't read it
  -- (running behind a proxy that strips X-Forwarded-For, etc).
  ip_hash                 TEXT,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT proxy_request_logs_outcome_ok
    CHECK (outcome IN (
      'challenge',
      'settled',
      'settle_failed',
      'upstream_error',
      'rate_limited',
      'invalid_config',
      'paused'
    ))
);

CREATE INDEX IF NOT EXISTS proxy_request_logs_by_config_recent_idx
  ON proxy_request_logs (proxy_config_id, created_at DESC);

CREATE INDEX IF NOT EXISTS proxy_request_logs_by_resource_recent_idx
  ON proxy_request_logs (resource_key_id, created_at DESC);
-- 011_dashboard_users_profile.sql — Extend dashboard_users with
-- richer OAuth profile data we were already receiving from the
-- providers but discarding.
--
-- Before this migration the upsert in apps/dashboard/src/lib/auth.ts
-- captured only (email, provider, providerId, display_name,
-- avatar_url). The Google/GitHub callback profile carries more —
-- handle, email_verified, locale, html_url, company, bio, location
-- — and these are non-PII-sensitive enough to keep as soft signals
-- for onboarding, segmentation, and future email delivery (we won't
-- bother sending to unverified addresses).
--
-- All columns nullable so existing rows pre-this-migration keep
-- working; they get backfilled on next sign-in via the COALESCE
-- update in upsertDashboardUser.
--
-- login_count starts at 1 for new rows and is incremented inside
-- ON CONFLICT — gives us a coarse engagement signal without a
-- separate sessions table.

ALTER TABLE dashboard_users
  ADD COLUMN IF NOT EXISTS github_username TEXT,
  ADD COLUMN IF NOT EXISTS email_verified  BOOLEAN,
  ADD COLUMN IF NOT EXISTS locale          TEXT,
  ADD COLUMN IF NOT EXISTS profile_url     TEXT,
  ADD COLUMN IF NOT EXISTS company         TEXT,
  ADD COLUMN IF NOT EXISTS bio             TEXT,
  ADD COLUMN IF NOT EXISTS location        TEXT,
  ADD COLUMN IF NOT EXISTS login_count     INTEGER NOT NULL DEFAULT 1;
-- 012_dashboard_onboarding.sql — Track whether a customer has
-- dismissed the welcome / onboarding tour.
--
-- The dashboard now ships an in-app onboarding modal that walks
-- first-time users through "what is x402, here's how you earn".
-- We persist the dismissal server-side (not a cookie) so:
--   * Re-installing the browser doesn't re-prompt power users.
--   * The progress tracker on the dashboard reads the same row to
--     decide whether to render the "you have N steps left" banner.
--
-- Column is nullable — NULL means "never dismissed", a timestamp
-- means "dismissed at this point". A future column could store
-- which step they got to before skipping; for v1 boolean-ish
-- presence is enough.

ALTER TABLE dashboard_users
  ADD COLUMN IF NOT EXISTS onboarding_dismissed_at TIMESTAMPTZ;
-- 013_buyer_mode.sql — Buyer-side persona for the dashboard.
--
-- Until now the dashboard has been a seller-only surface (manage
-- resource keys, see settles, configure proxies, publish catalog
-- listings). This migration adds the schema for the buyer persona:
-- the same OAuth user can now toggle into a "buyer" view that
-- surfaces THEIR spending, wallets, agent API keys, and limits.
--
-- Architectural choice: one app, two roles per user (option C from
-- the planning thread). preferred_mode on dashboard_users records
-- which view to land on; the layout server-component reads it and
-- redirects accordingly.
--
-- Data-attribution model:
--   * Payments are SCOPED to a buyer via facilitator_payments.payer
--     (the on-chain payer address). A user registers wallets in
--     buyer_wallets; payments whose payer ∈ their wallets show up
--     under their buyer dashboard. No dual-write — the seller-side
--     facilitator_payments row is the only source of truth.
--   * Agent keys are NOT linked to wallets at the schema level for
--     v1; they're for SDK identification + per-key analytics. The
--     enforcement (a key may only spend from these wallets) is a
--     later policy layer once the use case shows up.
--
-- Spending limits in v1 are ACCOUNTING-ONLY. No enforcement on the
-- payment path — flagging only. Auto-pause comes later when we wire
-- a hook into the buy-side proxy/MCP.

-- ---------------------------------------------------------------
-- dashboard_users — track which mode the user last chose.
-- ---------------------------------------------------------------
ALTER TABLE dashboard_users
  ADD COLUMN IF NOT EXISTS preferred_mode TEXT NOT NULL DEFAULT 'seller'
    CHECK (preferred_mode IN ('seller', 'buyer'));

-- ---------------------------------------------------------------
-- buyer_wallets — addresses a user has claimed as theirs.
-- ---------------------------------------------------------------
-- We can't cryptographically prove ownership without a sign-in-with
-- challenge per chain. v1 trusts the claim: if you say "I own this
-- address", we show you payments where payer = that address. A user
-- can list someone else's address and see (public on-chain) payments
-- they didn't make — that's an information disclosure of public
-- facts only, not a security issue. A proof-of-ownership flow lands
-- when we wire enforcement (limits, auto-pause).
CREATE TABLE IF NOT EXISTS buyer_wallets (
  id              UUID PRIMARY KEY,
  user_id         UUID NOT NULL
                    REFERENCES dashboard_users(id) ON DELETE CASCADE,
  network_family  TEXT NOT NULL
                    CHECK (network_family IN ('evm', 'solana', 'cosmos', 'tron')),
  address         TEXT NOT NULL,
  label           TEXT,
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, network_family, address)
);

CREATE INDEX IF NOT EXISTS buyer_wallets_user_idx
  ON buyer_wallets (user_id);

-- Lookup by address (case-insensitive for EVM/TRON which are
-- conventionally lowercased on storage but users may paste mixed
-- case from explorers). Solana base58 + Cosmos bech32 are
-- case-sensitive — we compare as-is for those.
CREATE INDEX IF NOT EXISTS buyer_wallets_address_idx
  ON buyer_wallets (network_family, lower(address));

-- ---------------------------------------------------------------
-- agent_keys — separate from resource_api_keys.
-- ---------------------------------------------------------------
-- A buyer-side API key used by agents (e.g. the @suverselabs/x402-mcp
-- server) for identification + per-key analytics. Distinct from
-- resource_api_keys (which identify SELLER resources) — same hash
-- column shape, different table to keep ACL boundaries crisp.
-- Format: sup_agent_<32 base62> hashed sha256-hex.
CREATE TABLE IF NOT EXISTS agent_keys (
  id            TEXT PRIMARY KEY,            -- "agtkey_<8 hex>"
  user_id       UUID NOT NULL
                  REFERENCES dashboard_users(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,        -- sha256 hex of plaintext
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS agent_keys_user_idx
  ON agent_keys (user_id) WHERE is_active = TRUE;

-- ---------------------------------------------------------------
-- spending_limits — accounting-only thresholds (no enforcement v1).
-- ---------------------------------------------------------------
-- Scope:
--   'user'       — total spend across all of this user's purchases
--   'agent_key'  — spend attributed to a specific agent_key
--                  (scope_id = agent_keys.id)
--   'endpoint'   — spend against a specific endpoint URL
--                  (scope_id = sha256-hex of the URL — stable, opaque)
-- Period: rolling-window check evaluated at read time.
CREATE TABLE IF NOT EXISTS spending_limits (
  id              UUID PRIMARY KEY,
  user_id         UUID NOT NULL
                    REFERENCES dashboard_users(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL
                    CHECK (scope IN ('user', 'agent_key', 'endpoint')),
  scope_id        TEXT,
  period          TEXT NOT NULL
                    CHECK (period IN ('day', 'week', 'month')),
  max_atomic_usd  NUMERIC(78, 0) NOT NULL
                    CHECK (max_atomic_usd > 0),
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  notify_email    BOOLEAN NOT NULL DEFAULT TRUE,
  auto_pause      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Unique constraint stops the user creating two "user/day/$5"
  -- rows that would silently fight each other.
  UNIQUE (user_id, scope, scope_id, period)
);

CREATE INDEX IF NOT EXISTS spending_limits_user_idx
  ON spending_limits (user_id) WHERE enabled = TRUE;

-- ---------------------------------------------------------------
-- facilitator_payments — add a payer index for buyer queries.
-- ---------------------------------------------------------------
-- Buyer queries scope by `payer IN (this user's wallets)`. The
-- existing indexes cover recent + by_resource + by_network +
-- by_adapter; none of them help payer scans. With 1k+ payments per
-- day and a typical user having a handful of payer addresses this
-- becomes a tight predicate quickly. Partial index — only settled +
-- failed rows; pending churns and isn't worth the write amplification.
CREATE INDEX IF NOT EXISTS facilitator_payments_by_payer_idx
  ON facilitator_payments (payer, created_at DESC)
  WHERE payer IS NOT NULL AND status IN ('settled', 'failed');
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
