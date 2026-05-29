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
