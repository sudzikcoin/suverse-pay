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
