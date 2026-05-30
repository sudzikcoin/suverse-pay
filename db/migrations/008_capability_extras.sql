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
