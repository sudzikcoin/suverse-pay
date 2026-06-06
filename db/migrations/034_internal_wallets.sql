-- 034_internal_wallets.sql — single source of truth for "self" wallets.
--
-- Until now the dashboard's "external vs self" split was driven by a
-- hardcoded SELF_WALLETS const in apps/dashboard/src/lib/dashboard-
-- aggregates.ts. Every time a new QA bot or merchant wallet came up
-- it had to be appended to the const and the app redeployed, or it
-- would inflate the "external revenue" widgets and pollute the
-- Recent External Activity feed on the overview page.
--
-- This table replaces the const. The dashboard's aggregate layer
-- reads the address column on a short cache and feeds it into the
-- existing `<> ALL($::text[])` filters in place of the const. New
-- wallets can be added with a plain INSERT — no redeploy needed.
--
-- `network` and `label` are informational only — the exclusion
-- filter matches purely on `address` (case-insensitive for EVM
-- 0x… addresses, see app-side lower() coercion).

CREATE TABLE IF NOT EXISTS internal_wallets (
  id         SERIAL PRIMARY KEY,
  address    VARCHAR(80) UNIQUE NOT NULL,
  network    VARCHAR(30),
  label      VARCHAR(100),
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed: explicit wallets from the dashboard UX brief plus every
-- address previously listed in the hardcoded SELF_WALLETS const, so
-- the switch-over does not regress the external/self split.
INSERT INTO internal_wallets (address, network, label) VALUES
  ('0x3869dE7597bDEa0172B97143f3eed806D8b84bf3', 'base',   'base-payer test buyer'),
  ('0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0', 'base',   'Base merchant'),
  ('CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM', 'solana', 'Solana merchant'),
  ('noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj', 'cosmos', 'Cosmos merchant'),
  ('26edvkZ99Lfs6LEwfSbfbJG17NM6z4BqrWMk7Z8hTe4D', 'solana', 'Solana service'),
  ('GEytKjbGUTnBH2M55sRNMibim2LgLMamHBRnXXofdDQk', 'solana', 'QA bot Solana'),
  ('0x0145ee0B440300928291668eDC5557f4B0779087', 'base',   'QA bot Base'),
  ('0x09939648B56A776de9783eaE750A7fBE725761f1', 'base',   'legacy self-wallet'),
  ('8Hy7D9NAiB9FDjS4wU3LhWu6EEQE6AE5xFaBxgyyYai6', 'solana', 'legacy self-wallet'),
  ('noble1r56pr4wl0f305m38var66jkqdh8ve2ue89pcm0', 'cosmos', 'legacy self-wallet'),
  ('HFYkH6SUuXLvzGbuB76vJ8u76NG3X25wdd1A7mDM4cSw', 'solana', 'legacy self-wallet')
ON CONFLICT (address) DO NOTHING;
