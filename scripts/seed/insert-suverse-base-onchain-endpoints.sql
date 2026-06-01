-- Seed: five first-party Base on-chain read endpoints (no upstream x402).
-- Idempotent — re-runs are safe; UPSERT on (resource_key_id, endpoint_slug).
-- Same shape as insert-suverse-helius-endpoints.sql.
--
-- Endpoints:
--   base-tx-decoder         ($0.05)  base_rpc_tx_decoder       (public Base RPC)
--   evm-token-risk-base     ($0.20)  goplus_token_risk_base    (GoPlus)
--   base-wallet-history     ($0.10)  blockscout_base_wallet_history
--   base-token-holders      ($0.10)  blockscout_base_token_holders
--   base-contract-info      ($0.05)  etherscan_base_contract_info (Etherscan V2)
--
-- All five accept Base + Solana + Cosmos USDC at the same merchant
-- addresses as our existing first-party row, carry a catalog_listings
-- row (status='approved') so CDP's bazaar crawler picks them up, and
-- point original_url at the canonical proxy.suverse.io path (unused
-- at runtime but NOT NULL on the column).

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. base-tx-decoder
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
    'base-tx-decoder',
    'base-tx-decoder',
    'https://proxy.suverse.io/v1/data/base-tx-decoder',
    'POST',
    'Base Chain Transaction Decoder',
    'Decode any Base chain transaction by hash into a structured human readable summary. Returns invoked smart contracts with labels like Uniswap Aerodrome Aave Compound, ERC20 token transfers with amounts, native ETH transfers, gas usage, and a one line intent summary. Critical for AI agents analyzing wallet activity on Base and debugging failed transactions.',
    50000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'base_rpc_tx_decoder'
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
  'Base Chain Transaction Decoder',
  'Decode any Base chain transaction by hash into a structured human readable summary. Returns invoked smart contracts with labels like Uniswap Aerodrome Aave Compound, ERC20 token transfers with amounts, native ETH transfers, gas usage, and a one line intent summary. Critical for AI agents analyzing wallet activity on Base and debugging failed transactions.',
  'https://proxy.suverse.io/v1/data/base-tx-decoder',
  ARRAY['base','transaction','decode','evm','analytics'],
  50000, 50000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'base-tx-decoder',
  '{"tx_hash":"0xb044ab1d32d52d3ebb3689f651071d8d4f9ae0aba55afce64c5e692efdee1ab6"}',
  '{"chain":"base","chainId":8453,"hash":"0xb044ab1d32d52d3ebb3689f651071d8d4f9ae0aba55afce64c5e692efdee1ab6","from":"0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0","to":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","status":"success","gasUsed":"62159","erc20Transfers":[{"token":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","from":"0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0","to":"0xa1d64d42a1fbece70794d38b3bee1c69a1c3ba99"}],"transferCount":1,"summary":"1 ERC20 transfer(s) on Base"}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 2. evm-token-risk-base
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
    'evm-token-risk-base',
    'evm-token-risk-base',
    'https://proxy.suverse.io/v1/data/evm-token-risk-base',
    'POST',
    'Base ERC20 Token Risk Scan',
    'Comprehensive risk analysis for any ERC20 token on Base chain. Checks ownership renounced, mint authority, blacklist functions, honeypot detection, top holder concentration, and 20+ security signals. Returns composite 0 to 100 risk score with red flags and green flags. Critical for AI trading agents avoiding scam tokens and DeFi due diligence.',
    200000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'goplus_token_risk_base'
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
  'Base ERC20 Token Risk Scan',
  'Comprehensive risk analysis for any ERC20 token on Base chain. Checks ownership renounced, mint authority, blacklist functions, honeypot detection, top holder concentration, and 20+ security signals. Returns composite 0 to 100 risk score with red flags and green flags. Critical for AI trading agents avoiding scam tokens and DeFi due diligence.',
  'https://proxy.suverse.io/v1/data/evm-token-risk-base',
  ARRAY['base','token','risk','security','rugpull'],
  200000, 200000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'evm-token-risk-base',
  '{"contract_address":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}',
  '{"chain":"base","chainId":8453,"contract":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","name":"USD Coin","symbol":"USDC","ownerRenounced":true,"riskScore":0,"verdict":"low_risk","redFlags":[],"greenFlags":["owner_renounced","source_verified","listed_on_dex"],"top10ConcentrationPct":42.13,"holderCount":850000}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 3. base-wallet-history
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
    'base-wallet-history',
    'base-wallet-history',
    'https://proxy.suverse.io/v1/data/base-wallet-history',
    'POST',
    'Base Wallet Transaction History',
    'Get recent transaction history for any Base wallet address with parsed details. Returns up to 20 recent transactions with hash, timestamp, value in ETH, token transfers, gas paid, transaction type swap transfer mint nft, counterparty, and one line description. Essential for AI portfolio managers, tax tools, and trading bots tracking activity on Base.',
    100000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'blockscout_base_wallet_history'
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
  'Base Wallet Transaction History',
  'Get recent transaction history for any Base wallet address with parsed details. Returns up to 20 recent transactions with hash, timestamp, value in ETH, token transfers, gas paid, transaction type swap transfer mint nft, counterparty, and one line description. Essential for AI portfolio managers, tax tools, and trading bots tracking activity on Base.',
  'https://proxy.suverse.io/v1/data/base-wallet-history',
  ARRAY['base','wallet','history','transactions','analytics'],
  100000, 100000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'base-wallet-history',
  '{"address":"0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0","limit":20}',
  '{"chain":"base","chainId":8453,"address":"0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0","count":2,"transactions":[{"hash":"0xb044ab1d32d52d3ebb3689f651071d8d4f9ae0aba55afce64c5e692efdee1ab6","blockNumber":37989679,"valueEth":0,"success":true,"method":"transfer","types":["token_transfer"]},{"hash":"0xc1e9...","blockNumber":37989200,"valueEth":0.001,"success":true,"method":null,"types":["coin_transfer"]}],"nextPageCursor":{"beforeBlock":37989199}}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 4. base-token-holders
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
    'base-token-holders',
    'base-token-holders',
    'https://proxy.suverse.io/v1/data/base-token-holders',
    'POST',
    'Base ERC20 Token Holder Distribution',
    'Get top token holders for any ERC20 contract on Base chain with concentration metrics. Returns holder addresses, balance, percentage of supply, unique holder count, top 10 concentration ratio, and whale flags for holdings above 1 percent. Critical for AI agents detecting concentrated supply pump and dump risk and tracking distribution over time.',
    100000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'blockscout_base_token_holders'
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
  'Base ERC20 Token Holder Distribution',
  'Get top token holders for any ERC20 contract on Base chain with concentration metrics. Returns holder addresses, balance, percentage of supply, unique holder count, top 10 concentration ratio, and whale flags for holdings above 1 percent. Critical for AI agents detecting concentrated supply pump and dump risk and tracking distribution over time.',
  'https://proxy.suverse.io/v1/data/base-token-holders',
  ARRAY['base','token','holders','distribution','whales'],
  100000, 100000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'base-token-holders',
  '{"contract_address":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}',
  '{"chain":"base","chainId":8453,"contract":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","name":"USD Coin","symbol":"USDC","decimals":6,"totalSupply":"3000000000000","totalHolders":850000,"sampleSize":50,"top1ConcentrationPct":15.2,"top10ConcentrationPct":42.1,"whaleCount":12}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 5. base-contract-info
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
    'base-contract-info',
    'base-contract-info',
    'https://proxy.suverse.io/v1/data/base-contract-info',
    'POST',
    'Base Smart Contract Info Lookup',
    'Get detailed information for any verified smart contract on Base chain. Returns contract name, compiler version, source code availability, full ABI, implementation address for proxies, license type, optimization runs, and EVM version. Essential for AI agents verifying contract authenticity, security audits, and integrating new protocols.',
    50000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'etherscan_base_contract_info'
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
  'Base Smart Contract Info Lookup',
  'Get detailed information for any verified smart contract on Base chain. Returns contract name, compiler version, source code availability, full ABI, implementation address for proxies, license type, optimization runs, and EVM version. Essential for AI agents verifying contract authenticity, security audits, and integrating new protocols.',
  'https://proxy.suverse.io/v1/data/base-contract-info',
  ARRAY['base','contract','smart-contract','verification','evm'],
  50000, 50000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'base-contract-info',
  '{"contract_address":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}',
  '{"chain":"base","chainId":8453,"contract":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","verified":true,"name":"FiatTokenProxy","compilerVersion":"v0.6.12+commit.27d51765","isProxy":true,"implementationAddress":"0x2ce6311ddae708829bc0784c967b7d77d19fd779","licenseType":"MIT","optimizationUsed":true,"runs":200}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

COMMIT;
