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
  settled_at          TIMESTAMPTZ
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
