-- Seed: SuVerse Base Token Swap (first-party LiFi-routed Base swap).
-- Idempotent — re-runs are safe.
--
-- Sister of insert-suverse-solana-swap.sql. Same rationale:
--   * seller_proxy_configs row exists primarily for dashboard listing
--     + bazaar discovery. The real flow is at
--     /v1/swap/base/quote + /v1/swap/base/execute/{quote_id} because
--     swap pricing is per-quote and the generic handler pipeline uses
--     a static price_atomic.
--   * catalog_listings row (auto-approved) so the public catalog
--     surfaces the Base swap and the dashboard shows it.
--
-- price_atomic = 1000 ($0.001) — table minimum. The real cost is
-- decided by /quote and enforced by the bespoke /execute route.
-- internal_handler = 'swap_base_execute' which returns 503 with a
-- redirect to /v1/swap/base/* if anyone hits /v1/data/suverse-base-swap.
--
-- accepted_networks: only Base mainnet — the swap pays output ERC20s
-- to the buyer's EVM payer address; multi-chain inbound is out of
-- scope for v1.
--
-- pay_to_evm = the dedicated swap liquidity wallet
-- (0x4261701A4dDf4625EBfA80CEefB5B3B2b5453B2E). USDC paid via x402
-- lands there, the wallet performs the LiFi swap, then forwards the
-- output ERC20 to the buyer.

BEGIN;

WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, price_atomic,
    accepted_networks,
    pay_to_evm,
    forward_auth_scheme,
    is_active,
    upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'suverse-base-swap',
    'suverse-base-swap',
    'https://proxy.suverse.io/v1/swap/base/quote',
    'POST',
    'SuVerse Base Token Swap',
    'Bidirectional SuVerse Base swap (LiFi-routed). USDC to any ERC20 on Base, or any ERC20 on Base to USDC. Two-step flow: POST /v1/swap/base/quote with input_token, output_token, input_amount, slippage_bps; then POST /v1/swap/base/execute/{quote_id} with x402 payment. Quote response carries direction, requires_approval, approval_target. Reverse swaps (token to USDC) require the buyer to call ERC20.approve(swap_wallet, input_amount) BEFORE /execute; quote returns requires_approval=true. Forward x402 amount is input + 1 percent fee; reverse x402 amount is the fee only (input pulled via transferFrom). Maximum 50 USDC per swap. Slippage 10 to 500 bps. Output delivered within 60 seconds. Quotes expire after 60 seconds. Minimum swap depends on direction: forward from $1 (or $1.10 first time a router needs approve); reverse from $1.50. Errors: 400 quote_too_small; 412 needs_approval with current/required allowance; 422 slippage_exceeded.',
    1000,
    ARRAY['eip155:8453'],
    '0x4261701A4dDf4625EBfA80CEefB5B3B2b5453B2E',
    'static',
    true,
    false,
    'swap_base_execute'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug      = EXCLUDED.public_slug,
        display_name     = EXCLUDED.display_name,
        description      = EXCLUDED.description,
        price_atomic     = EXCLUDED.price_atomic,
        accepted_networks= EXCLUDED.accepted_networks,
        pay_to_evm       = EXCLUDED.pay_to_evm,
        original_url     = EXCLUDED.original_url,
        is_active        = EXCLUDED.is_active,
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
  'SuVerse Base Token Swap',
  'Bidirectional SuVerse Base swap via LiFi. USDC to any ERC20 on Base, or any ERC20 on Base to USDC. Two-step flow: POST /v1/swap/base/quote then POST /v1/swap/base/execute/{quote_id} with x402 payment. Reverse direction needs ERC20 approve to the swap wallet first; quote returns requires_approval and approval_target. Maximum 50 USDC per swap, 1 percent fee, delivered within 60 seconds.',
  'https://proxy.suverse.io/v1/swap/base/quote',
  ARRAY['base','evm','swap','dex','lifi','erc20','aggregator','suverse'],
  1000,
  50000000,
  'per-call',
  ARRAY['eip155:8453'],
  'approved',
  proxy_ins.resource_key_id,
  'suverse-base-swap',
  '{"input_token":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","output_token":"0x4200000000000000000000000000000000000006","input_amount":"1000000","slippage_bps":100}',
  '{"quote_id":"qb_abc123def456","input_token":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","output_token":"0x4200000000000000000000000000000000000006","input_amount":"1000000","expected_output":"508097690066750","expected_output_human":"508097690066750 atomic","tool":"sushiswap","fee":"10000","fee_human":"0.01 USDC","total_cost":"1010000","total_cost_human":"1.01 USDC","expires_at":"2026-06-01T19:00:00.000Z","x402_pay_url":"https://proxy.suverse.io/v1/swap/base/execute/qb_abc123def456"}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

COMMIT;
