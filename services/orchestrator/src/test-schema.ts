/**
 * Inline DDL used by orchestrator unit tests to bootstrap a pg-mem
 * instance. Mirrors the migrations that ship in `db/migrations/`
 * (Step 8), kept here so the orchestrator can test its own SQL
 * without a runtime dependency on the migration file layout.
 *
 * Two simplifications vs. the production schema:
 *  - REFERENCES clauses are kept but providers/api_keys rows must be
 *    seeded by the test setup.
 *  - BIGSERIAL is used as in production; pg-mem supports it.
 */
export const TEST_SCHEMA_SQL = `
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
  id              TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  config          JSONB NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS provider_capabilities (
  provider_id     TEXT NOT NULL REFERENCES providers(id),
  network         TEXT NOT NULL,
  asset           TEXT NOT NULL,
  scheme          TEXT NOT NULL,
  is_static       BOOLEAN NOT NULL DEFAULT FALSE,
  is_discovered   BOOLEAN NOT NULL DEFAULT FALSE,
  discovered_at   TIMESTAMPTZ,
  superseded_at   TIMESTAMPTZ,
  PRIMARY KEY (provider_id, network, asset, scheme)
);

CREATE TABLE IF NOT EXISTS provider_health_checks (
  id              BIGSERIAL PRIMARY KEY,
  provider_id     TEXT NOT NULL REFERENCES providers(id),
  status          TEXT NOT NULL,
  latency_ms      INTEGER,
  error           TEXT,
  checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id                  TEXT PRIMARY KEY,
  idempotency_key     TEXT,
  api_key_id          TEXT NOT NULL REFERENCES api_keys(id),
  status              TEXT NOT NULL,
  network             TEXT NOT NULL,
  asset               TEXT NOT NULL,
  amount              NUMERIC(78,0) NOT NULL,
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

CREATE UNIQUE INDEX IF NOT EXISTS payments_idempotency_idx
  ON payments (api_key_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_attempts (
  id              BIGSERIAL PRIMARY KEY,
  payment_id      TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  attempt_number  INTEGER NOT NULL,
  provider_id     TEXT NOT NULL REFERENCES providers(id),
  outcome         TEXT NOT NULL,
  error_code      TEXT,
  error_message   TEXT,
  latency_ms      INTEGER,
  provider_response JSONB,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS routing_decisions (
  id              BIGSERIAL PRIMARY KEY,
  payment_id      TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  candidate_providers JSONB NOT NULL,
  selected_provider_id TEXT NOT NULL,
  policy          JSONB NOT NULL,
  scores          JSONB NOT NULL,
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
