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
