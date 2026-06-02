-- Seed: SuVerse Solana Token Swap (first-party Jupiter-routed swap).
-- Idempotent — re-runs are safe.
--
-- Inserts:
--   * seller_proxy_configs row primarily for dashboard listing /
--     bazaar discovery metadata. The actual swap flow lives at two
--     dedicated routes (/v1/swap/solana/quote + /execute/:quoteId)
--     because swap pricing is per-quote and the standard handler
--     pipeline uses a static price_atomic.
--   * catalog_listings row (auto-approved) so the public catalog
--     surfaces the swap and the dashboard shows it.
--
-- price_atomic is the table's minimum legal value (1000 = $0.001).
-- The real swap cost is determined by the /quote endpoint and
-- enforced by the bespoke /execute route. internal_handler is set
-- to 'swap_solana_execute' which returns 503 with a redirect to the
-- dedicated /v1/swap/solana/* routes if anyone accidentally hits
-- /v1/data/suverse-solana-swap.
--
-- accepted_networks intentionally lists only Solana — the swap pays
-- output tokens to the buyer's payer address, which must be a
-- Solana pubkey. Multi-chain incoming is out of scope for v1.

BEGIN;

WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, price_atomic,
    accepted_networks,
    pay_to_solana,
    forward_auth_scheme,
    is_active,
    upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'suverse-solana-swap',
    'suverse-solana-swap',
    'https://proxy.suverse.io/v1/swap/solana/quote',
    'POST',
    'SuVerse Solana Token Swap',
    'Bidirectional SuVerse Solana swap (Jupiter-routed). USDC to any SPL token, or any SPL token to USDC. Two-step flow: POST /v1/swap/solana/quote with input_mint, output_mint, input_amount, slippage_bps; then POST /v1/swap/solana/execute/{quote_id} with x402 payment. Quote response carries direction, requires_approval, approval_target. Reverse swaps (token to USDC) require the buyer to call SPL Token Approve setting the swap wallet as a delegate over input_amount BEFORE /execute; quote returns requires_approval=true with approval_target. Forward x402 amount is input + 1 percent fee. Reverse x402 amount is the fee only (input pulled via delegate). Maximum 50 USDC per swap on either side. Slippage 10 to 500 bps. Output delivered to the paying wallet within 30 seconds. Quotes expire after 60 seconds. Minimum swap depends on direction and token novelty: forward common SPL from $0.20, brand-new SPL from $40 for ATA rent; reverse from $0.50 with input ATA present, $40 when the swap wallet has no input ATA yet. Errors: 400 quote_too_small with minimum_input_atomic; 412 needs_approval with current/required delegate amounts; 422 slippage_exceeded with expected_min/actual.',
    1000,
    ARRAY['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
    'HFYkH6SUuXLvzGbuB76vJ8u76NG3X25wdd1A7mDM4cSw',
    'static',
    true,
    false,
    'swap_solana_execute'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug      = EXCLUDED.public_slug,
        display_name     = EXCLUDED.display_name,
        description      = EXCLUDED.description,
        price_atomic     = EXCLUDED.price_atomic,
        accepted_networks= EXCLUDED.accepted_networks,
        pay_to_solana    = EXCLUDED.pay_to_solana,
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
  'SuVerse Solana Token Swap',
  'Bidirectional SuVerse Solana swap via Jupiter. USDC to any SPL token, or any SPL token to USDC. Two-step flow: POST /v1/swap/solana/quote then POST /v1/swap/solana/execute/{quote_id} with x402 payment. Reverse direction needs SPL Approve to the swap wallet first; quote returns requires_approval and approval_target. Maximum 50 USDC per swap, 1 percent fee, delivered within 30 seconds.',
  'https://proxy.suverse.io/v1/swap/solana/quote',
  ARRAY['solana','swap','dex','jupiter','spl','suverse'],
  1000,
  50000000,
  'per-call',
  ARRAY['solana:mainnet'],
  'approved',
  proxy_ins.resource_key_id,
  'suverse-solana-swap',
  '{"input_mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","output_mint":"So11111111111111111111111111111111111111112","input_amount":"10000000","slippage_bps":100}',
  '{"quote_id":"q_abc123def456","input_token":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","output_token":"So11111111111111111111111111111111111111112","input_amount":"10000000","expected_output":"47900000","expected_output_human":"0.0479 SOL","price_impact_pct":0.05,"fee":"100000","fee_human":"0.1 USDC","total_cost":"10100000","total_cost_human":"10.1 USDC","expires_at":"2026-06-01T09:00:00.000Z","x402_pay_url":"https://proxy.suverse.io/v1/swap/solana/execute/q_abc123def456"}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

COMMIT;
