-- Seed: four first-party Helius-backed endpoints (no upstream x402).
-- Idempotent — re-runs are safe; UPSERT on (resource_key_id,
-- endpoint_slug). Same shape as insert-suverse-solana-tx-decoder.sql.
--
-- Endpoints:
--   suverse-solana-tx-simulator  ($0.10)  helius_tx_simulator
--   suverse-solana-priority-fee  ($0.01)  helius_priority_fee
--   suverse-nft-metadata         ($0.05)  helius_nft_metadata
--   suverse-wallet-history       ($0.05)  helius_wallet_history
--
-- All four:
--   * accept Base + Solana + Cosmos USDC (same merchant addresses as
--     the existing first-party row);
--   * carry a catalog_listings row (status='approved') so CDP's bazaar
--     crawler picks them up — sample_request_json + sample_response_json
--     match the handler contract;
--   * point original_url at the canonical proxy.suverse.io path
--     (unused at runtime but NOT NULL on the column).

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. suverse-solana-tx-simulator
-- ─────────────────────────────────────────────────────────────────────
WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, price_atomic,
    accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos,
    forward_auth_scheme,
    is_active, upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'suverse-solana-tx-simulator',
    'suverse-solana-tx-simulator',
    'https://proxy.suverse.io/v1/data/suverse-solana-tx-simulator',
    'POST',
    'SuVerse Solana Transaction Pre-Flight Simulator',
    'Simulate a Solana transaction before broadcasting to mainnet. Returns success/failure status, compute units consumed, full program logs, accounts touched, and detailed error messages if simulation fails. Essential for AI agents validating transactions before paying gas, MEV bots, wallet integrations, and DeFi protocols.',
    100000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'helius_tx_simulator'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug      = EXCLUDED.public_slug,
        display_name     = EXCLUDED.display_name,
        description      = EXCLUDED.description,
        price_atomic     = EXCLUDED.price_atomic,
        accepted_networks= EXCLUDED.accepted_networks,
        pay_to_evm       = EXCLUDED.pay_to_evm,
        pay_to_solana    = EXCLUDED.pay_to_solana,
        pay_to_cosmos    = EXCLUDED.pay_to_cosmos,
        updated_at       = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url,
  tags, price_atomic_min, price_atomic_max, price_unit,
  networks, status, resource_key_id, slug,
  sample_request_json, sample_response_json,
  proxy_config_id
)
SELECT
  gen_random_uuid(),
  'SuVerse Solana Transaction Pre-Flight Simulator',
  'Simulate a Solana transaction before broadcasting to mainnet. Returns success/failure status, compute units consumed, full program logs, accounts touched, and detailed error messages if simulation fails. Essential for AI agents validating transactions before paying gas, MEV bots, wallet integrations, and DeFi protocols.',
  'https://proxy.suverse.io/v1/data/suverse-solana-tx-simulator',
  ARRAY['solana','simulation','preflight','mev','transaction'],
  100000, 100000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-solana-tx-simulator',
  '{"transaction":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}',
  '{"success":true,"error":null,"logs":["Program 11111111111111111111111111111111 invoke [1]","Program 11111111111111111111111111111111 success"],"computeUnits":150,"accountsTouched":[]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 2. suverse-solana-priority-fee
-- ─────────────────────────────────────────────────────────────────────
WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, price_atomic,
    accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos,
    forward_auth_scheme,
    is_active, upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'suverse-solana-priority-fee',
    'suverse-solana-priority-fee',
    'https://proxy.suverse.io/v1/data/suverse-solana-priority-fee',
    'POST',
    'SuVerse Solana Priority Fee Estimator',
    'Get optimal Solana priority fee recommendations in real-time. Returns suggested micro-lamports per compute unit across percentiles (min, low, medium, high, veryHigh, unsafeMax) based on recent network congestion. Critical for AI trading bots wanting fast inclusion, payment apps balancing cost vs speed, and dApps optimizing UX. Eliminates failed transactions due to underpriced fees and saves money by avoiding overpriced ones.',
    10000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'helius_priority_fee'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug      = EXCLUDED.public_slug,
        display_name     = EXCLUDED.display_name,
        description      = EXCLUDED.description,
        price_atomic     = EXCLUDED.price_atomic,
        accepted_networks= EXCLUDED.accepted_networks,
        pay_to_evm       = EXCLUDED.pay_to_evm,
        pay_to_solana    = EXCLUDED.pay_to_solana,
        pay_to_cosmos    = EXCLUDED.pay_to_cosmos,
        updated_at       = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url,
  tags, price_atomic_min, price_atomic_max, price_unit,
  networks, status, resource_key_id, slug,
  sample_request_json, sample_response_json,
  proxy_config_id
)
SELECT
  gen_random_uuid(),
  'SuVerse Solana Priority Fee Estimator',
  'Get optimal Solana priority fee recommendations in real-time. Returns suggested micro-lamports per compute unit across percentiles (min, low, medium, high, veryHigh, unsafeMax) based on recent network congestion. Critical for AI trading bots wanting fast inclusion, payment apps balancing cost vs speed, and dApps optimizing UX. Eliminates failed transactions due to underpriced fees and saves money by avoiding overpriced ones.',
  'https://proxy.suverse.io/v1/data/suverse-solana-priority-fee',
  ARRAY['solana','priority-fee','gas','trading','fees'],
  10000, 10000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-solana-priority-fee',
  '{}',
  '{"priorityFeeLevels":{"min":0,"low":1,"medium":10,"high":100,"veryHigh":1000,"unsafeMax":100000},"priorityFeeEstimate":10}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 3. suverse-nft-metadata
-- ─────────────────────────────────────────────────────────────────────
WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, price_atomic,
    accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos,
    forward_auth_scheme,
    is_active, upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'suverse-nft-metadata',
    'suverse-nft-metadata',
    'https://proxy.suverse.io/v1/data/suverse-nft-metadata',
    'POST',
    'SuVerse Solana NFT Metadata',
    'Fetch comprehensive metadata for any Solana NFT or compressed NFT (cNFT). Returns full asset details including name, symbol, image, collection, creators with royalty splits, attributes, ownership, mutability, and on-chain authorities. Supports Metaplex Token Metadata standard and DAS (Digital Asset Standard). Essential for AI agents browsing collections, marketplace bots, wallet integrations displaying portfolios, and analytics platforms tracking ownership.',
    50000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'helius_nft_metadata'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug      = EXCLUDED.public_slug,
        display_name     = EXCLUDED.display_name,
        description      = EXCLUDED.description,
        price_atomic     = EXCLUDED.price_atomic,
        accepted_networks= EXCLUDED.accepted_networks,
        pay_to_evm       = EXCLUDED.pay_to_evm,
        pay_to_solana    = EXCLUDED.pay_to_solana,
        pay_to_cosmos    = EXCLUDED.pay_to_cosmos,
        updated_at       = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url,
  tags, price_atomic_min, price_atomic_max, price_unit,
  networks, status, resource_key_id, slug,
  sample_request_json, sample_response_json,
  proxy_config_id
)
SELECT
  gen_random_uuid(),
  'SuVerse Solana NFT Metadata',
  'Fetch comprehensive metadata for any Solana NFT or compressed NFT (cNFT). Returns full asset details including name, symbol, image, collection, creators with royalty splits, attributes, ownership, mutability, and on-chain authorities. Supports Metaplex Token Metadata standard and DAS (Digital Asset Standard). Essential for AI agents browsing collections, marketplace bots, wallet integrations displaying portfolios, and analytics platforms tracking ownership.',
  'https://proxy.suverse.io/v1/data/suverse-nft-metadata',
  ARRAY['solana','nft','metadata','das','collectibles'],
  50000, 50000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-nft-metadata',
  '{"mint":"F9Lw3ki3hJ7PF9HQXsBzoY8GyE6sPPiqUyT5RGUMtwba"}',
  '{"id":"F9Lw3ki3hJ7PF9HQXsBzoY8GyE6sPPiqUyT5RGUMtwba","interface":"ProgrammableNFT","content":{"metadata":{"name":"Mad Lad #1234","symbol":"MAD"}},"creators":[{"address":"5XQ2Dy...","share":100}],"royalty":{"percent":0.05},"ownership":{"owner":"OWNER...","frozen":false},"mutable":true,"burnt":false}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 4. suverse-wallet-history
-- ─────────────────────────────────────────────────────────────────────
WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, price_atomic,
    accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos,
    forward_auth_scheme,
    is_active, upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'suverse-wallet-history',
    'suverse-wallet-history',
    'https://proxy.suverse.io/v1/data/suverse-wallet-history',
    'POST',
    'SuVerse Solana Wallet Transaction History',
    'Get parsed transaction history for any Solana wallet address. Returns recent transactions with human-readable descriptions, types (SWAP, TRANSFER, NFT_SALE, etc.), token transfers, native SOL transfers, fees, and timestamps. Pagination via before/until cursors. Critical for AI portfolio managers, tax tools, wallet analytics, and trading bots tracking competitor activity. Far more usable than raw RPC getSignaturesForAddress.',
    50000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'helius_wallet_history'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug      = EXCLUDED.public_slug,
        display_name     = EXCLUDED.display_name,
        description      = EXCLUDED.description,
        price_atomic     = EXCLUDED.price_atomic,
        accepted_networks= EXCLUDED.accepted_networks,
        pay_to_evm       = EXCLUDED.pay_to_evm,
        pay_to_solana    = EXCLUDED.pay_to_solana,
        pay_to_cosmos    = EXCLUDED.pay_to_cosmos,
        updated_at       = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url,
  tags, price_atomic_min, price_atomic_max, price_unit,
  networks, status, resource_key_id, slug,
  sample_request_json, sample_response_json,
  proxy_config_id
)
SELECT
  gen_random_uuid(),
  'SuVerse Solana Wallet Transaction History',
  'Get parsed transaction history for any Solana wallet address. Returns recent transactions with human-readable descriptions, types (SWAP, TRANSFER, NFT_SALE, etc.), token transfers, native SOL transfers, fees, and timestamps. Pagination via before/until cursors. Critical for AI portfolio managers, tax tools, wallet analytics, and trading bots tracking competitor activity. Far more usable than raw RPC getSignaturesForAddress.',
  'https://proxy.suverse.io/v1/data/suverse-wallet-history',
  ARRAY['solana','wallet','history','transactions','analytics'],
  50000, 50000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-wallet-history',
  '{"address":"JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN","limit":10}',
  '{"address":"JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN","count":2,"transactions":[{"signature":"5abc...","type":"SWAP","description":"Swapped USDC for SOL","fee":5000,"timestamp":1780000000},{"signature":"6def...","type":"TRANSFER","description":"Sent 1 SOL","fee":5000,"timestamp":1779999000}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

COMMIT;
