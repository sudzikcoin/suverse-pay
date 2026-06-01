-- Seed: five first-party Cosmos ecosystem read endpoints
-- (no upstream x402). Idempotent — UPSERT on
-- (resource_key_id, endpoint_slug). Same shape as the Base / Helius
-- seeds.
--
-- Endpoints (all $0.05-$0.10):
--   cosmos-tx-decoder        cosmos_tx_decoder
--   cosmos-wallet-balance    cosmos_wallet_balance
--   cosmos-validator-stats   cosmos_validator_stats
--   cosmos-ibc-tracker       cosmos_ibc_tracker
--   cosmos-chain-info        cosmos_chain_info
--
-- All five back onto public Cosmos LCDs (publicnode, polkachu) for
-- cosmoshub / noble / osmosis / juno / stride. No API keys.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. cosmos-tx-decoder
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
    'cosmos-tx-decoder',
    'cosmos-tx-decoder',
    'https://proxy.suverse.io/v1/data/cosmos-tx-decoder',
    'POST',
    'Cosmos Chain Transaction Decoder',
    'Decode any Cosmos SDK transaction by hash from any Cosmos chain including Cosmos Hub, Noble, Osmosis, Juno, Stride. Returns message types MsgSend MsgTransfer MsgDelegate, sender and receiver addresses, amounts, fee paid, gas used, success flag, memo, and timestamp. Critical for AI agents analyzing Cosmos ecosystem activity and IBC transfers.',
    50000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'cosmos_tx_decoder'
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
  'Cosmos Chain Transaction Decoder',
  'Decode any Cosmos SDK transaction by hash from any Cosmos chain including Cosmos Hub, Noble, Osmosis, Juno, Stride. Returns message types MsgSend MsgTransfer MsgDelegate, sender and receiver addresses, amounts, fee paid, gas used, success flag, memo, and timestamp. Critical for AI agents analyzing Cosmos ecosystem activity and IBC transfers.',
  'https://proxy.suverse.io/v1/data/cosmos-tx-decoder',
  ARRAY['cosmos','transaction','decode','ibc','analytics'],
  50000, 50000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'cosmos-tx-decoder',
  '{"chain":"cosmoshub","tx_hash":"d1c528c1efde7c3a8b67f60d36b1b4ce92f9d7e58fda1a3c75a6dee8d8e1be8a"}',
  '{"chain":"cosmoshub","chainId":"cosmoshub-4","txHash":"D1C528C1EFDE7C3A8B67F60D36B1B4CE92F9D7E58FDA1A3C75A6DEE8D8E1BE8A","height":21000000,"timestamp":"2026-06-01T00:00:00Z","success":true,"gasUsed":80000,"fee":[{"denom":"uatom","amount":"5000"}],"memo":"","messageCount":1,"messages":[{"type":"/cosmos.bank.v1beta1.MsgSend","summary":"Send from cosmos1abc to cosmos1xyz"}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 2. cosmos-wallet-balance
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
    'cosmos-wallet-balance',
    'cosmos-wallet-balance',
    'https://proxy.suverse.io/v1/data/cosmos-wallet-balance',
    'POST',
    'Cosmos Wallet Multi Chain Balance',
    'Get token balances for any Cosmos wallet address with chain detection from the bech32 prefix. Returns native balance, IBC token balances with the raw ibc slash hash denom, IBC denom count, native denom flag, and pagination total. Essential for AI portfolio managers tracking Cosmos ecosystem positions and IBC token tracing for bridges.',
    100000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'cosmos_wallet_balance'
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
  'Cosmos Wallet Multi Chain Balance',
  'Get token balances for any Cosmos wallet address with chain detection from the bech32 prefix. Returns native balance, IBC token balances with the raw ibc slash hash denom, IBC denom count, native denom flag, and pagination total. Essential for AI portfolio managers tracking Cosmos ecosystem positions and IBC token tracing for bridges.',
  'https://proxy.suverse.io/v1/data/cosmos-wallet-balance',
  ARRAY['cosmos','wallet','balance','multi-chain','ibc'],
  100000, 100000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'cosmos-wallet-balance',
  '{"address":"cosmos1tygms3xhhs3yv487phx3dw4a95jn7t7lpm470r"}',
  '{"chain":"cosmoshub","chainId":"cosmoshub-4","address":"cosmos1tygms3xhhs3yv487phx3dw4a95jn7t7lpm470r","nativeDenom":"uatom","nativeBalance":"5000000","balanceCount":3,"ibcDenomCount":2,"balances":[{"denom":"uatom","amount":"5000000","isIbc":false,"isNative":true},{"denom":"ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2","amount":"100000","isIbc":true,"isNative":false}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 3. cosmos-validator-stats
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
    'cosmos-validator-stats',
    'cosmos-validator-stats',
    'https://proxy.suverse.io/v1/data/cosmos-validator-stats',
    'POST',
    'Cosmos Validator Statistics',
    'Get current validator statistics for any Cosmos chain. Returns validator operator address, moniker, bonded tokens, delegator shares, commission rate plus max rate and max change rate, jailed status, bonding status, min self delegation, and slashing window parameters. Critical for AI staking agents picking validators and portfolio tools.',
    50000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'cosmos_validator_stats'
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
  'Cosmos Validator Statistics',
  'Get current validator statistics for any Cosmos chain. Returns validator operator address, moniker, bonded tokens, delegator shares, commission rate plus max rate and max change rate, jailed status, bonding status, min self delegation, and slashing window parameters. Critical for AI staking agents picking validators and portfolio tools.',
  'https://proxy.suverse.io/v1/data/cosmos-validator-stats',
  ARRAY['cosmos','validator','staking','apr','governance'],
  50000, 50000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'cosmos-validator-stats',
  '{"chain":"cosmoshub","validator":"cosmosvaloper1sjllsnramtg7ewxqwwrwjxfgc4n4ef9u2lcnj0"}',
  '{"chain":"cosmoshub","chainId":"cosmoshub-4","operatorAddress":"cosmosvaloper1sjllsnramtg7ewxqwwrwjxfgc4n4ef9u2lcnj0","moniker":"Coinbase Custody","jailed":false,"status":"BOND_STATUS_BONDED","bondedTokens":"15000000000000","commissionRate":0.05,"maxCommissionRate":0.2,"slashingParams":{"windowSize":10000,"minSignedPerWindow":0.05}}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 4. cosmos-ibc-tracker
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
    'cosmos-ibc-tracker',
    'cosmos-ibc-tracker',
    'https://proxy.suverse.io/v1/data/cosmos-ibc-tracker',
    'POST',
    'Cosmos IBC Transfer Tracker',
    'Track any IBC transfer between Cosmos chains by source chain transaction hash. Returns source channel and port, destination channel and port, packet sequence, timeout height and timestamp, sender, receiver, token denom, amount, and lifecycle status sent acknowledged in flight or timed out. Essential for cross chain monitoring and stuck transfer debugging.',
    100000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'cosmos_ibc_tracker'
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
  'Cosmos IBC Transfer Tracker',
  'Track any IBC transfer between Cosmos chains by source chain transaction hash. Returns source channel and port, destination channel and port, packet sequence, timeout height and timestamp, sender, receiver, token denom, amount, and lifecycle status sent acknowledged in flight or timed out. Essential for cross chain monitoring and stuck transfer debugging.',
  'https://proxy.suverse.io/v1/data/cosmos-ibc-tracker',
  ARRAY['cosmos','ibc','cross-chain','transfer','tracking'],
  100000, 100000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'cosmos-ibc-tracker',
  '{"chain":"cosmoshub","tx_hash":"a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2"}',
  '{"chain":"cosmoshub","chainId":"cosmoshub-4","txHash":"A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2","ibcDetected":true,"success":true,"status":"in_flight","sourceChannel":"channel-141","sourcePort":"transfer","destChannel":"channel-0","destPort":"transfer","sequence":"12345","sender":"cosmos1abc","receiver":"osmo1xyz","denom":"uatom","amount":"1000000"}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 5. cosmos-chain-info
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
    'cosmos-chain-info',
    'cosmos-chain-info',
    'https://proxy.suverse.io/v1/data/cosmos-chain-info',
    'POST',
    'Cosmos Chain Network Info',
    'Get current network information for any Cosmos chain including current block height, latest block time, sampled average block time, total staking supply, bonded tokens, bonded ratio percentage staked, active validator count, denom count, and chain ID. Useful for AI agents monitoring chain health and comparing economics across Cosmos ecosystem.',
    50000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'cosmos_chain_info'
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
  'Cosmos Chain Network Info',
  'Get current network information for any Cosmos chain including current block height, latest block time, sampled average block time, total staking supply, bonded tokens, bonded ratio percentage staked, active validator count, denom count, and chain ID. Useful for AI agents monitoring chain health and comparing economics across Cosmos ecosystem.',
  'https://proxy.suverse.io/v1/data/cosmos-chain-info',
  ARRAY['cosmos','chain','network','analytics','staking'],
  50000, 50000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'cosmos-chain-info',
  '{"chain":"cosmoshub"}',
  '{"chain":"cosmoshub","chainId":"cosmoshub-4","latestHeight":31376629,"latestBlockTime":"2026-06-01T06:59:37Z","avgBlockTimeSeconds":6.2,"stakingDenom":"uatom","totalStakingSupply":"400000000000000","bondedTokens":"200000000000000","bondedRatio":0.5,"activeValidatorCount":180,"denomCount":42}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

COMMIT;
