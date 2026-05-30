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
