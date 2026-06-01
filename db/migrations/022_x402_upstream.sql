-- 022_x402_upstream.sql — wrap any 402-protected upstream API behind
-- our own proxy. When enabled, the proxy itself acts as an x402 buyer:
-- it forwards the customer's request to the upstream, expects a 402
-- challenge back, picks the matching accept by `upstream_x402_network`,
-- signs with a service-side wallet keyed off the namespace, and replays
-- the request with X-Payment. The customer pays us once on whichever
-- network they chose; we pay the upstream once on whichever network
-- the upstream requires. The margin between the two is our take.
--
-- All four columns are optional and default to "off". Existing proxy
-- rows continue to work unchanged (upstream is plain HTTPS, no 402).
--
-- Field notes:
--
--   upstream_x402_enabled — feature switch. When false, the proxy
--     behaves as it does today (forward → return whatever upstream
--     gives back). When true, the proxy enters the buyer flow on a
--     402 from upstream and short-circuits to 503 on any other 5xx.
--
--   upstream_x402_network — CAIP-2 the upstream demands. Used to pick
--     the matching `accepts[]` entry out of the upstream's 402 body.
--     If the upstream's 402 has no accept with this network, the
--     proxy returns 503 — we never silently pay a different network.
--
--   upstream_x402_max_price — defensive cap in human-readable USDC
--     (e.g. 0.500000 = 50¢). NUMERIC(20,6) deliberately mismatches
--     the atomic NUMERIC(78,0) used elsewhere in this table because
--     this column is sized for the upstream's published price, which
--     facilitators advertise in decimal USDC, not atomic units. The
--     proxy refuses to sign if the upstream's quoted price exceeds
--     this — protection against an upstream silently jacking the rate.
--
--   upstream_signer_wallet — namespace label ("solana" today, room
--     for "evm" / "cosmos" later) that picks which service wallet
--     keypair env-var pair the proxy should use. Today only the
--     SERVICE_SOLANA_ADDRESS + SERVICE_SOLANA_PRIVKEY_PATH pair
--     exists. Free text rather than an enum so we don't need a
--     follow-up migration when a new chain is added.

ALTER TABLE seller_proxy_configs
  ADD COLUMN IF NOT EXISTS upstream_x402_enabled   BOOLEAN        NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS upstream_x402_network   TEXT,
  ADD COLUMN IF NOT EXISTS upstream_x402_max_price NUMERIC(20, 6),
  ADD COLUMN IF NOT EXISTS upstream_signer_wallet  TEXT;
