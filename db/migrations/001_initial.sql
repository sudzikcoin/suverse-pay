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
