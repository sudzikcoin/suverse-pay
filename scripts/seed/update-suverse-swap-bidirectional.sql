-- Description-only refresh for the two SuVerse swap proxies and their
-- public catalog rows, to reflect the new bidirectional (USDC↔token)
-- capability. The original insert scripts have `ON CONFLICT DO NOTHING`
-- on catalog_listings so re-running them does not refresh prod text —
-- this script does the targeted UPDATEs idempotently.
--
-- Safe to re-run. Affects only description columns.

BEGIN;

-- Solana swap (slug = suverse-solana-swap)
UPDATE seller_proxy_configs
SET description = 'Bidirectional SuVerse Solana swap (Jupiter-routed). USDC to any SPL token, or any SPL token to USDC. Two-step flow: POST /v1/swap/solana/quote with input_mint, output_mint, input_amount, slippage_bps; then POST /v1/swap/solana/execute/{quote_id} with x402 payment. Quote response carries direction, requires_approval, approval_target. Reverse swaps (token to USDC) require the buyer to call SPL Token Approve setting the swap wallet as a delegate over input_amount BEFORE /execute; quote returns requires_approval=true with approval_target. Forward x402 amount is input + 1 percent fee. Reverse x402 amount is the fee only (input pulled via delegate). Maximum 50 USDC per swap on either side. Slippage 10 to 500 bps. Output delivered to the paying wallet within 30 seconds. Quotes expire after 60 seconds. Minimum swap depends on direction and token novelty: forward common SPL from $0.20, brand-new SPL from $40 for ATA rent; reverse from $0.50 with input ATA present, $40 when the swap wallet has no input ATA yet. Errors: 400 quote_too_small with minimum_input_atomic; 412 needs_approval with current/required delegate amounts; 422 slippage_exceeded with expected_min/actual.',
    updated_at = NOW()
WHERE endpoint_slug = 'suverse-solana-swap';

UPDATE catalog_listings
SET description = 'Bidirectional SuVerse Solana swap via Jupiter. USDC to any SPL token, or any SPL token to USDC. Two-step flow: POST /v1/swap/solana/quote then POST /v1/swap/solana/execute/{quote_id} with x402 payment. Reverse direction needs SPL Approve to the swap wallet first; quote returns requires_approval and approval_target. Maximum 50 USDC per swap, 1 percent fee, delivered within 30 seconds.'
WHERE slug = 'suverse-solana-swap';

-- Base swap (slug = suverse-base-swap)
UPDATE seller_proxy_configs
SET description = 'Bidirectional SuVerse Base swap (LiFi-routed). USDC to any ERC20 on Base, or any ERC20 on Base to USDC. Two-step flow: POST /v1/swap/base/quote with input_token, output_token, input_amount, slippage_bps; then POST /v1/swap/base/execute/{quote_id} with x402 payment. Quote response carries direction, requires_approval, approval_target. Reverse swaps (token to USDC) require the buyer to call ERC20.approve(swap_wallet, input_amount) BEFORE /execute; quote returns requires_approval=true. Forward x402 amount is input + 1 percent fee; reverse x402 amount is the fee only (input pulled via transferFrom). Maximum 50 USDC per swap. Slippage 10 to 500 bps. Output delivered within 60 seconds. Quotes expire after 60 seconds. Minimum swap depends on direction: forward from $1 (or $1.10 first time a router needs approve); reverse from $1.50. Errors: 400 quote_too_small; 412 needs_approval with current/required allowance; 422 slippage_exceeded.',
    updated_at = NOW()
WHERE endpoint_slug = 'suverse-base-swap';

UPDATE catalog_listings
SET description = 'Bidirectional SuVerse Base swap via LiFi. USDC to any ERC20 on Base, or any ERC20 on Base to USDC. Two-step flow: POST /v1/swap/base/quote then POST /v1/swap/base/execute/{quote_id} with x402 payment. Reverse direction needs ERC20 approve to the swap wallet first; quote returns requires_approval and approval_target. Maximum 50 USDC per swap, 1 percent fee, delivered within 60 seconds.'
WHERE slug = 'suverse-base-swap';

COMMIT;
