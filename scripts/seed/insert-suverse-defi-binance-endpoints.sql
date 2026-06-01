-- Seed: ten first-party endpoints across DeFiLlama (5), GeckoTerminal
-- (2), and Binance public (3). Idempotent — re-runs safe via UPSERT.
--
-- Same merchant addresses + resource_key as the prior Helius + CoinGecko
-- batches. Descriptions kept ASCII-only and trimmed to 335-365 chars
-- to stay clear of the CDP /verify rejection threshold (trap #6,
-- reference-cdp-bazaar-indexing).

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. suverse-defi-tvl-chain  ($0.01)
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
    'suverse-defi-tvl-chain',
    'suverse-defi-tvl-chain',
    'https://proxy.suverse.io/v1/data/suverse-defi-tvl-chain',
    'POST',
    'DeFi TVL by Chain',
    'Total value locked TVL for every blockchain network where DeFi exists. Returns each chain name, current TVL in USD, 24h change, 7d change, and chain id. Critical for AI agents tracking chain growth, capital rotations, market share shifts between Ethereum and L2s, and identifying emerging ecosystems. Real-time data from DeFiLlama covering 300+ chains.',
    10000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'defillama_tvl_chain'
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
  sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'DeFi TVL by Chain',
  'Total value locked TVL for every blockchain network where DeFi exists. Returns each chain name, current TVL in USD, 24h change, 7d change, and chain id. Critical for AI agents tracking chain growth, capital rotations, market share shifts between Ethereum and L2s, and identifying emerging ecosystems. Real-time data from DeFiLlama covering 300+ chains.',
  'https://proxy.suverse.io/v1/data/suverse-defi-tvl-chain',
  ARRAY['defi','tvl','chains','analytics','ecosystem'],
  10000, 10000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-defi-tvl-chain',
  '{}',
  '{"count":2,"chains":[{"name":"Ethereum","chain_id":1,"token_symbol":"ETH","tvl_usd":52000000000,"change_1d":0.5,"change_7d":2.1},{"name":"Base","chain_id":8453,"token_symbol":"ETH","tvl_usd":3200000000,"change_1d":1.4,"change_7d":4.2}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 2. suverse-defi-protocol-tvl  ($0.02)
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
    'suverse-defi-protocol-tvl',
    'suverse-defi-protocol-tvl',
    'https://proxy.suverse.io/v1/data/suverse-defi-protocol-tvl',
    'POST',
    'Protocol TVL History',
    'Historical TVL for any DeFi protocol over the last 90 days. Returns daily TVL points for protocols like Aave, Uniswap, Lido, Curve, MakerDAO, Compound, and 3000+ others. Essential for AI agents analyzing protocol growth, comparing competitive positioning, detecting capital outflows, and building dashboards showing TVL trends. Powered by DeFiLlama.',
    20000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'defillama_protocol_tvl'
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
  sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Protocol TVL History',
  'Historical TVL for any DeFi protocol over the last 90 days. Returns daily TVL points for protocols like Aave, Uniswap, Lido, Curve, MakerDAO, Compound, and 3000+ others. Essential for AI agents analyzing protocol growth, comparing competitive positioning, detecting capital outflows, and building dashboards showing TVL trends. Powered by DeFiLlama.',
  'https://proxy.suverse.io/v1/data/suverse-defi-protocol-tvl',
  ARRAY['defi','tvl','protocol','history','analytics'],
  20000, 20000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-defi-protocol-tvl',
  '{"protocol":"aave-v3"}',
  '{"protocol":"aave-v3","name":"Aave V3","symbol":"AAVE","category":"Lending","home_chain":"Ethereum","tvl_series_days":2,"tvl_series":[{"date":1779609600,"tvl_usd":12000000000},{"date":1779696000,"tvl_usd":12100000000}],"current_chain_tvls":{"Ethereum":8000000000}}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 3. suverse-defi-yield-pools  ($0.03)
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
    'suverse-defi-yield-pools',
    'suverse-defi-yield-pools',
    'https://proxy.suverse.io/v1/data/suverse-defi-yield-pools',
    'POST',
    'Top DeFi Yield Pools',
    'Top DeFi yield farming pools ranked by APY across 800+ protocols on all chains. Returns pool name, project, chain, TVL in USD, current APY, base APY, reward APY, IL risk, and stablecoin flag. Critical for AI yield bots, portfolio rebalancers, yield aggregators, and treasury managers seeking risk-adjusted returns. Filter by minimum TVL.',
    30000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'defillama_yield_pools'
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
  sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Top DeFi Yield Pools',
  'Top DeFi yield farming pools ranked by APY across 800+ protocols on all chains. Returns pool name, project, chain, TVL in USD, current APY, base APY, reward APY, IL risk, and stablecoin flag. Critical for AI yield bots, portfolio rebalancers, yield aggregators, and treasury managers seeking risk-adjusted returns. Filter by minimum TVL.',
  'https://proxy.suverse.io/v1/data/suverse-defi-yield-pools',
  ARRAY['defi','yield','farming','apy','pools'],
  30000, 30000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-defi-yield-pools',
  '{"min_tvl":1000000,"limit":20}',
  '{"min_tvl":1000000,"limit":20,"universe_size":15234,"count":20,"pools":[{"pool_id":"abc-123","symbol":"USDC-ETH","project":"uniswap-v3","chain":"Ethereum","tvl_usd":250000000,"apy":12.34,"apy_base":7.5,"apy_reward":4.84,"il_risk":"yes","stablecoin":false,"exposure":"multi"}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 4. suverse-bridge-volumes  ($0.02) — INACTIVE until upstream returns
--
-- DeFiLlama moved `bridges.llama.fi/bridges` (and adjacent paths
-- /overview, /bridgevolume, /lastdayvolume) behind a paid plan at
-- some point before 2026-06-01 — every free-tier call now returns
-- HTTP 402 "Upgrade to the paid API plan". Buyer would be charged
-- the $0.02, the handler would 502, the response would never come
-- back. Set is_active=false on first seed so the endpoint shows up
-- as 404 to traffic; flip to true when the upstream resolves or a
-- replacement source ships. Handler code + catalog row both stay so
-- a future admin can reactivate without re-deploy.
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
    'suverse-bridge-volumes',
    'suverse-bridge-volumes',
    'https://proxy.suverse.io/v1/data/suverse-bridge-volumes',
    'POST',
    'Cross-Chain Bridge Volumes 24h',
    '24 hour bridge transfer volumes for major cross-chain bridges including Stargate, Wormhole, Across, deBridge, Layer Zero, and Circle CCTP. Returns each bridge name, volume USD, transaction count, and chains served. Useful for AI agents tracking capital flows between chains, detecting liquidity migrations, monitoring bridge health, and identifying trends.',
    20000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    false, false,
    'defillama_bridges'
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
  sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Cross-Chain Bridge Volumes 24h',
  '24 hour bridge transfer volumes for major cross-chain bridges including Stargate, Wormhole, Across, deBridge, Layer Zero, and Circle CCTP. Returns each bridge name, volume USD, transaction count, and chains served. Useful for AI agents tracking capital flows between chains, detecting liquidity migrations, monitoring bridge health, and identifying trends.',
  'https://proxy.suverse.io/v1/data/suverse-bridge-volumes',
  ARRAY['defi','bridges','cross-chain','volume','analytics'],
  20000, 20000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'pending', proxy_ins.resource_key_id, 'suverse-bridge-volumes',
  '{}',
  '{"count":2,"bridges":[{"name":"stargate","display_name":"Stargate","volume_prev_day_usd":150000000,"volume_prev_2day_usd":140000000,"txs_prev_day":5000,"chains":["Ethereum","Arbitrum","Base"]},{"name":"across","display_name":"Across","volume_prev_day_usd":80000000,"volume_prev_2day_usd":75000000,"txs_prev_day":3000,"chains":["Ethereum","Optimism"]}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 5. suverse-defi-fees  ($0.02)
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
    'suverse-defi-fees',
    'suverse-defi-fees',
    'https://proxy.suverse.io/v1/data/suverse-defi-fees',
    'POST',
    'Protocol Fees and Revenue',
    '24h, 7d, and 30d fee revenue for top DeFi protocols ranked by earnings. Returns protocol name, category, fees collected, revenue to treasury, and growth metrics. Perfect for AI agents identifying most profitable DeFi protocols, comparing business models, tracking protocol-owned revenue vs user fees, and DeFi valuation analysis. Covers 200+ protocols.',
    20000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'defillama_fees'
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
  sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Protocol Fees and Revenue',
  '24h, 7d, and 30d fee revenue for top DeFi protocols ranked by earnings. Returns protocol name, category, fees collected, revenue to treasury, and growth metrics. Perfect for AI agents identifying most profitable DeFi protocols, comparing business models, tracking protocol-owned revenue vs user fees, and DeFi valuation analysis. Covers 200+ protocols.',
  'https://proxy.suverse.io/v1/data/suverse-defi-fees',
  ARRAY['defi','fees','revenue','protocols','earnings'],
  20000, 20000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-defi-fees',
  '{}',
  '{"market_totals":{"total_24h":15000000,"total_7d":110000000,"total_30d":450000000},"count":1,"protocols":[{"name":"Uniswap","category":"Dexes","chains":["Ethereum","Arbitrum","Base"],"fees_24h":2500000,"fees_7d":18000000,"fees_30d":72000000,"fees_all_time":4500000000,"change_1d":1.2,"change_7d":-0.4,"change_1m":3.1}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 6. suverse-base-dex-pools  ($0.01)
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
    'suverse-base-dex-pools',
    'suverse-base-dex-pools',
    'https://proxy.suverse.io/v1/data/suverse-base-dex-pools',
    'POST',
    'Base Chain Top DEX Pools',
    'Top liquidity pools on Base across Uniswap V3, Aerodrome, BaseSwap and others. Returns each pool token pair, TVL in USD, 24h volume, fee tier, and APR. Critical for AI agents finding deepest liquidity on Base, identifying high volume pairs for routing, tracking new pool launches, and DeFi strategy on the fastest growing L2. Real-time from GeckoTerminal.',
    10000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'geckoterminal_base_pools'
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
  sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Base Chain Top DEX Pools',
  'Top liquidity pools on Base across Uniswap V3, Aerodrome, BaseSwap and others. Returns each pool token pair, TVL in USD, 24h volume, fee tier, and APR. Critical for AI agents finding deepest liquidity on Base, identifying high volume pairs for routing, tracking new pool launches, and DeFi strategy on the fastest growing L2. Real-time from GeckoTerminal.',
  'https://proxy.suverse.io/v1/data/suverse-base-dex-pools',
  ARRAY['defi','dex','base','pools','liquidity'],
  10000, 10000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-base-dex-pools',
  '{"limit":10}',
  '{"chain":"base","limit":10,"count":1,"pools":[{"id":"base_0xabc","address":"0xabc","name":"WETH / USDC","dex":"uniswap_v3_base","base_token":"base_0xWETH","quote_token":"base_0xUSDC","reserve_usd":"12345678","volume_24h_usd":"9876543","price_change_24h_pct":"1.23","base_token_price_usd":"3500.10","pool_created_at":"2026-01-01T00:00:00Z"}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 7. suverse-solana-dex-pools  ($0.01)
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
    'suverse-solana-dex-pools',
    'suverse-solana-dex-pools',
    'https://proxy.suverse.io/v1/data/suverse-solana-dex-pools',
    'POST',
    'Solana Chain Top DEX Pools',
    'Top liquidity pools on Solana across Raydium, Orca, Meteora and other DEXs. Returns each pool token pair, TVL in USD, 24h volume, fee tier, and current price. Essential for AI Solana trading bots finding liquidity, MEV searchers, arbitrage agents, and Jupiter aggregator users. Includes both concentrated and standard liquidity pools.',
    10000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'geckoterminal_solana_pools'
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
  sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Solana Chain Top DEX Pools',
  'Top liquidity pools on Solana across Raydium, Orca, Meteora and other DEXs. Returns each pool token pair, TVL in USD, 24h volume, fee tier, and current price. Essential for AI Solana trading bots finding liquidity, MEV searchers, arbitrage agents, and Jupiter aggregator users. Includes both concentrated and standard liquidity pools.',
  'https://proxy.suverse.io/v1/data/suverse-solana-dex-pools',
  ARRAY['defi','dex','solana','pools','raydium','orca'],
  10000, 10000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-solana-dex-pools',
  '{"limit":10}',
  '{"chain":"solana","limit":10,"count":1,"pools":[{"id":"solana_xyz","address":"xyz","name":"SOL / USDC","dex":"raydium","base_token":"solana_SOL","quote_token":"solana_USDC","reserve_usd":"42000000","volume_24h_usd":"15000000","price_change_24h_pct":"0.42","base_token_price_usd":"150.00","pool_created_at":"2025-12-01T00:00:00Z"}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 8. suverse-binance-orderbook  ($0.005)
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
    'suverse-binance-orderbook',
    'suverse-binance-orderbook',
    'https://proxy.suverse.io/v1/data/suverse-binance-orderbook',
    'POST',
    'Binance Spot Order Book Snapshot',
    'Current order book snapshot for any Binance spot trading pair with top bids and asks. Returns price levels, quantities, total bid depth, total ask depth, and order book imbalance ratio. Perfect for AI trading bots detecting market pressure, MEV bots identifying arbitrage, price impact calculators, and market microstructure analysis. Real-time from Binance public.',
    5000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'binance_orderbook'
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
  sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Binance Spot Order Book Snapshot',
  'Current order book snapshot for any Binance spot trading pair with top bids and asks. Returns price levels, quantities, total bid depth, total ask depth, and order book imbalance ratio. Perfect for AI trading bots detecting market pressure, MEV bots identifying arbitrage, price impact calculators, and market microstructure analysis. Real-time from Binance public.',
  'https://proxy.suverse.io/v1/data/suverse-binance-orderbook',
  ARRAY['crypto','orderbook','binance','trading','depth'],
  5000, 5000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-binance-orderbook',
  '{"symbol":"BTCUSDT","limit":50}',
  '{"symbol":"BTCUSDT","last_update_id":12345,"bids":[["65400.10","0.5"],["65399.50","1.2"]],"asks":[["65400.50","0.4"],["65401.10","0.8"]],"bid_depth":1.7,"ask_depth":1.2,"imbalance_ratio":0.172}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 9. suverse-binance-trades  ($0.005)
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
    'suverse-binance-trades',
    'suverse-binance-trades',
    'https://proxy.suverse.io/v1/data/suverse-binance-trades',
    'POST',
    'Binance Recent Trades',
    'Last 100 executed trades for any Binance spot pair with price, quantity, side buy or sell, and timestamp. Essential for AI agents detecting whale activity, building VWAP calculations, identifying buy or sell pressure, tape reading bots, and tick-level analysis. Real-time public trade data with millisecond timestamps from the largest crypto exchange by spot volume.',
    5000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'binance_trades'
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
  sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Binance Recent Trades',
  'Last 100 executed trades for any Binance spot pair with price, quantity, side buy or sell, and timestamp. Essential for AI agents detecting whale activity, building VWAP calculations, identifying buy or sell pressure, tape reading bots, and tick-level analysis. Real-time public trade data with millisecond timestamps from the largest crypto exchange by spot volume.',
  'https://proxy.suverse.io/v1/data/suverse-binance-trades',
  ARRAY['crypto','trades','binance','tape','volume'],
  5000, 5000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-binance-trades',
  '{"symbol":"BTCUSDT","limit":100}',
  '{"symbol":"BTCUSDT","count":2,"trades":[{"id":1,"price":"65000.00","qty":"0.1","quote_qty":"6500.00","time":1780000000000,"side":"sell","is_best_match":true},{"id":2,"price":"65010.10","qty":"0.05","quote_qty":"3250.50","time":1780000001000,"side":"buy","is_best_match":true}]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 10. suverse-perp-funding  ($0.01)
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
    'suverse-perp-funding',
    'suverse-perp-funding',
    'https://proxy.suverse.io/v1/data/suverse-perp-funding',
    'POST',
    'Perpetual Funding Rates Binance',
    'Current funding rate for any perpetual contract on Binance Futures with next funding timestamp and predicted rate. Returns mark price, index price, mark-index spread, and funding history. Critical for AI agents trading perps, basis trading strategies, identifying funding arbitrage, monitoring leverage flush events, and quantifying market sentiment.',
    10000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true, false,
    'binance_funding'
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
  sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Perpetual Funding Rates Binance',
  'Current funding rate for any perpetual contract on Binance Futures with next funding timestamp and predicted rate. Returns mark price, index price, mark-index spread, and funding history. Critical for AI agents trading perps, basis trading strategies, identifying funding arbitrage, monitoring leverage flush events, and quantifying market sentiment.',
  'https://proxy.suverse.io/v1/data/suverse-perp-funding',
  ARRAY['crypto','perpetual','funding','derivatives','binance'],
  10000, 10000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'suverse-perp-funding',
  '{"symbol":"BTCUSDT"}',
  '{"symbol":"BTCUSDT","mark_price":65432.1,"index_price":65430.0,"mark_index_spread":2.1,"funding_rate":0.0001,"funding_rate_pct":0.01,"next_funding_time":1800000000000,"estimated_settle_price":65431.0,"interest_rate":0.0001,"time":1790000000000}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

COMMIT;
