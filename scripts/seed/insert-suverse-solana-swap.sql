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
    'Swap USDC into any SPL token on Solana using Jupiter aggregator. Best price routing across Raydium, Orca, Meteora, and 30+ Solana DEXs. Two step flow: first POST /v1/swap/solana/quote to get a quote_id and total_cost, then pay via x402 to POST /v1/swap/solana/execute/{quote_id}. Maximum 50 USDC per swap. Slippage protection from 10 to 500 basis points. Output tokens delivered directly to your wallet within 30 seconds. Service fee is 1% of input. Quotes expire after 60 seconds. Minimum swap depends on token novelty: common SPL tokens accept inputs from $0.20, but the first swap into a brand-new mint requires at least $40 to cover one-time SPL associated-token-account rent (~$0.40). The /quote response carries estimated_gas_cost_usd and minimum_input_atomic; if your input is below the floor the call returns HTTP 400 quote_too_small with the bumped minimum.',
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
  'Swap USDC into any SPL token on Solana via Jupiter aggregator. Two step flow: POST /v1/swap/solana/quote for price discovery, then POST /v1/swap/solana/execute/{quote_id} with x402 payment to settle the swap. Best routing across 30+ Solana DEXs. Maximum 50 USDC per swap. 1% service fee. Tokens delivered to the paying wallet within 30 seconds. Minimum input depends on output-token novelty: common SPL tokens accept from $0.20, brand-new mints require at least $40 to cover one-time ATA rent.',
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
