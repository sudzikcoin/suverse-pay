-- Seed: five first-party Bitcoin read endpoints (no upstream x402).
-- Idempotent — UPSERT on (resource_key_id, endpoint_slug). Same shape
-- as the Base / Cosmos / Helius seeds.
--
-- Endpoints:
--   bitcoin-tx-decoder         ($0.05)   bitcoin_tx_decoder
--   bitcoin-fees-recommended   ($0.005)  bitcoin_fees_recommended
--   bitcoin-address-info       ($0.05)   bitcoin_address_info
--   bitcoin-mempool-stats      ($0.005)  bitcoin_mempool_stats
--   bitcoin-block-info         ($0.01)   bitcoin_block_info
--
-- All five back onto mempool.space's public API. No keys, no auth.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. bitcoin-tx-decoder
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
    'bitcoin-tx-decoder',
    'bitcoin-tx-decoder',
    'https://proxy.suverse.io/v1/data/bitcoin-tx-decoder',
    'POST',
    'Bitcoin Transaction Decoder',
    'Decode any Bitcoin transaction by txid into a human readable structure. Returns inputs with source addresses and amounts, outputs with destinations and amounts, total value in BTC, fee in sats with sats per vbyte, confirmation status, block height, timestamp, size, weight, plus pattern flags coinbase RBF OP_RETURN SegWit Taproot. Critical for AI agents.',
    50000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'bitcoin_tx_decoder'
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
  'Bitcoin Transaction Decoder',
  'Decode any Bitcoin transaction by txid into a human readable structure. Returns inputs with source addresses and amounts, outputs with destinations and amounts, total value in BTC, fee in sats with sats per vbyte, confirmation status, block height, timestamp, size, weight, plus pattern flags coinbase RBF OP_RETURN SegWit Taproot. Critical for AI agents.',
  'https://proxy.suverse.io/v1/data/bitcoin-tx-decoder',
  ARRAY['bitcoin','transaction','decode','btc','analytics'],
  50000, 50000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'bitcoin-tx-decoder',
  '{"txid":"b1fea52486ce0c62bb442b530a3f0132b826c74e473d1f2c220bfa78111c5082"}',
  '{"chain":"bitcoin","txid":"b1fea52486ce0c62bb442b530a3f0132b826c74e473d1f2c220bfa78111c5082","isCoinbase":true,"feeSats":0,"confirmed":true,"blockHeight":9,"blockTime":1231473279,"inputCount":1,"outputCount":1,"totalOutputBtc":50,"hasOpReturn":false,"hasSegwit":false,"hasTaproot":false}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 2. bitcoin-fees-recommended
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
    'bitcoin-fees-recommended',
    'bitcoin-fees-recommended',
    'https://proxy.suverse.io/v1/data/bitcoin-fees-recommended',
    'POST',
    'Bitcoin Recommended Transaction Fees',
    'Get current recommended Bitcoin transaction fees based on mempool congestion. Returns fee rates in sats per vbyte for different confirmation speeds fastest half hour hour economy minimum. Includes mempool unconfirmed tx count, total mempool size in MB, total fee in sats, and a per fee tier histogram. Critical for AI agents broadcasting Bitcoin transactions.',
    5000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'bitcoin_fees_recommended'
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
  'Bitcoin Recommended Transaction Fees',
  'Get current recommended Bitcoin transaction fees based on mempool congestion. Returns fee rates in sats per vbyte for different confirmation speeds fastest half hour hour economy minimum. Includes mempool unconfirmed tx count, total mempool size in MB, total fee in sats, and a per fee tier histogram. Critical for AI agents broadcasting Bitcoin transactions.',
  'https://proxy.suverse.io/v1/data/bitcoin-fees-recommended',
  ARRAY['bitcoin','fees','mempool','btc','transactions'],
  5000, 5000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'bitcoin-fees-recommended',
  '{}',
  '{"chain":"bitcoin","satsPerVbyte":{"fastest":2,"halfHour":1,"hour":1,"economy":1,"minimum":1},"mempool":{"unconfirmedTxCount":111862,"totalVsizeMb":44.2,"totalFeeSats":9544511}}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 3. bitcoin-address-info
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
    'bitcoin-address-info',
    'bitcoin-address-info',
    'https://proxy.suverse.io/v1/data/bitcoin-address-info',
    'POST',
    'Bitcoin Address Balance and History',
    'Get balance and recent transaction history for any Bitcoin address. Returns confirmed balance in BTC and sats, unconfirmed mempool delta, total received and spent, confirmed and mempool tx counts, up to 20 recent transactions with timestamps and fees, plus address type classification p2pkh p2sh p2wpkh p2tr. Essential for AI agents tracking whale wallets.',
    50000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'bitcoin_address_info'
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
  'Bitcoin Address Balance and History',
  'Get balance and recent transaction history for any Bitcoin address. Returns confirmed balance in BTC and sats, unconfirmed mempool delta, total received and spent, confirmed and mempool tx counts, up to 20 recent transactions with timestamps and fees, plus address type classification p2pkh p2sh p2wpkh p2tr. Essential for AI agents tracking whale wallets.',
  'https://proxy.suverse.io/v1/data/bitcoin-address-info',
  ARRAY['bitcoin','address','wallet','balance','utxo'],
  50000, 50000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'bitcoin-address-info',
  '{"address":"bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"}',
  '{"chain":"bitcoin","address":"bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq","addressType":"p2wpkh","confirmedBalanceSats":16767240,"confirmedBalanceBtc":0.1676724,"unconfirmedBalanceSats":0,"totalBalanceSats":16767240,"confirmedTxCount":102,"totalReceivedSats":16781533,"recentTxCount":20}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 4. bitcoin-mempool-stats
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
    'bitcoin-mempool-stats',
    'bitcoin-mempool-stats',
    'https://proxy.suverse.io/v1/data/bitcoin-mempool-stats',
    'POST',
    'Bitcoin Mempool Real Time Statistics',
    'Get current Bitcoin mempool statistics in real time. Returns unconfirmed transaction count, total mempool vsize in MB, fee histogram, average sats per vbyte, current tip block height, and the next difficulty adjustment estimate with progress percent, remaining blocks, and average block time. Critical for AI agents timing Bitcoin transactions.',
    5000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'bitcoin_mempool_stats'
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
  'Bitcoin Mempool Real Time Statistics',
  'Get current Bitcoin mempool statistics in real time. Returns unconfirmed transaction count, total mempool vsize in MB, fee histogram, average sats per vbyte, current tip block height, and the next difficulty adjustment estimate with progress percent, remaining blocks, and average block time. Critical for AI agents timing Bitcoin transactions.',
  'https://proxy.suverse.io/v1/data/bitcoin-mempool-stats',
  ARRAY['bitcoin','mempool','realtime','btc','network'],
  5000, 5000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'bitcoin-mempool-stats',
  '{}',
  '{"chain":"bitcoin","tipHeight":951947,"mempool":{"unconfirmedTxCount":111862,"totalVsizeMb":44.2,"avgSatsPerVbyte":0.22},"difficultyAdjustment":{"progressPercent":19.59,"estimatedChange":-0.87,"remainingBlocks":1621,"avgBlockTimeSeconds":600}}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 5. bitcoin-block-info
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
    'bitcoin-block-info',
    'bitcoin-block-info',
    'https://proxy.suverse.io/v1/data/bitcoin-block-info',
    'POST',
    'Bitcoin Block Information',
    'Get detailed information for any Bitcoin block by height or hash. Returns block hash, height, timestamp, transaction count, total fees paid to miner, miner pool identification when known, block size and weight, difficulty, merkle root, version, nonce, and the list of transaction IDs up to 100. Useful for AI agents analyzing Bitcoin network state.',
    10000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'bitcoin_block_info'
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
  'Bitcoin Block Information',
  'Get detailed information for any Bitcoin block by height or hash. Returns block hash, height, timestamp, transaction count, total fees paid to miner, miner pool identification when known, block size and weight, difficulty, merkle root, version, nonce, and the list of transaction IDs up to 100. Useful for AI agents analyzing Bitcoin network state.',
  'https://proxy.suverse.io/v1/data/bitcoin-block-info',
  ARRAY['bitcoin','block','btc','mining','analytics'],
  10000, 10000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'bitcoin-block-info',
  '{"height":800000}',
  '{"chain":"bitcoin","hash":"00000000000000000002a7c4c1e48d76c5a37902165a270156b7a8d72728a054","height":800000,"timestamp":1690168629,"txCount":3721,"sizeBytes":1634536,"weight":3992881,"totalFeesSats":12345,"minerPool":"Foundry USA","minerPoolSlug":"foundryusa","txidCount":100,"txidsTruncated":true}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

COMMIT;
