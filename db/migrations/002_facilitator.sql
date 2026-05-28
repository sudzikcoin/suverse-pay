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
