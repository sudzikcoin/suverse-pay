-- Description refresh for SuVerse swap endpoints to match the new
-- semantic-search-optimized copy used in the live 402 challenge.
--
-- /v1/swap/{solana,base}/quote went from FREE to x402-paid at 1
-- atomic USDC ($0.000001). Three places need to know:
--
--   1. seller_proxy_configs.description — dashboard + admin views
--   2. catalog_listings.description — public catalog at
--      suverse-pay.suverse.io
--   3. apps/proxy/src/swap-quote-x402.ts — live 402 challenge.
--      CDP Bazaar indexes from here (already updated in code).
--
-- This file ships (1) and (2). The body matches the constant
-- `SOLANA_QUOTE_DESCRIPTION` and `BASE_QUOTE_DESCRIPTION` so the
-- copy stays consistent across all three surfaces.
--
-- Safe to re-run. Affects only description columns.

BEGIN;

-- Solana swap (slug = suverse-solana-swap) -----------------------------

UPDATE seller_proxy_configs
SET description = 'SuVerse Solana Swap - bidirectional token swap aggregator for Solana mainnet. Exchange USDC for any SPL token, or any SPL token for USDC, via Jupiter v6 routing across 30+ Solana DEXs including Raydium, Orca, Meteora, Lifinity, Phoenix, OpenBook, Saber. Supports memecoins BONK, WIF, POPCAT, MEW, BOME, FARTCOIN, GOAT, MOODENG and major tokens SOL, USDT, mSOL, JTO, JUP, PYTH, RNDR, RENDER, ORCA, RAY. Two-step flow. Step 1 POST /v1/swap/solana/quote (0.000001 USDC, 1 atomic) with body {input_mint, output_mint, input_amount, slippage_bps} returns quote_id, expected_output, x402_pay_url, expected_output_human, fee, total_cost, price_impact_pct, output_token metadata. Step 2 POST returned x402_pay_url with x402 payment for total_cost executes the swap. Output tokens delivered to paying wallet within 30 seconds. Slippage protection with bps tolerance. 1 percent service fee. Best price routing, real-time quote from Jupiter aggregator. Use cases: AI agent token swaps, automated trading bots, portfolio rebalancing, agentic DeFi, autonomous wallet operations, memecoin sniping, stablecoin exchange, SPL token conversion, on-chain trading, DEX aggregator API, x402 swap, payable swap, micro-swap, micropayment swap. Minimum swap depends on token novelty: known tokens with existing ATA 0.20 USD, new tokens requiring ATA creation 40 USD (covers Solana ATA rent). Reverse direction (token to USDC): requires SPL token approval to swap wallet before execute, returns 412 needs_approval if missing. Jupiter routes optimized for slippage and price. No KYC, no signup, payment via x402 USDC microtransactions on Solana mainnet.',
    updated_at = NOW()
WHERE endpoint_slug = 'suverse-solana-swap';

UPDATE catalog_listings
SET description = 'SuVerse Solana Swap - bidirectional token swap aggregator for Solana mainnet. Exchange USDC for any SPL token, or any SPL token for USDC, via Jupiter v6 routing across 30+ Solana DEXs including Raydium, Orca, Meteora, Lifinity, Phoenix, OpenBook, Saber. Supports memecoins BONK, WIF, POPCAT, MEW, BOME, FARTCOIN, GOAT, MOODENG and major tokens SOL, USDT, mSOL, JTO, JUP, PYTH, RNDR, RENDER, ORCA, RAY. Two-step flow. Step 1 POST /v1/swap/solana/quote (0.000001 USDC, 1 atomic) with body {input_mint, output_mint, input_amount, slippage_bps} returns quote_id, expected_output, x402_pay_url, expected_output_human, fee, total_cost, price_impact_pct, output_token metadata. Step 2 POST returned x402_pay_url with x402 payment for total_cost executes the swap. Output tokens delivered to paying wallet within 30 seconds. Slippage protection with bps tolerance. 1 percent service fee. Best price routing, real-time quote from Jupiter aggregator. Use cases: AI agent token swaps, automated trading bots, portfolio rebalancing, agentic DeFi, autonomous wallet operations, memecoin sniping, stablecoin exchange, SPL token conversion, on-chain trading, DEX aggregator API, x402 swap, payable swap, micro-swap, micropayment swap. Minimum swap depends on token novelty: known tokens with existing ATA 0.20 USD, new tokens requiring ATA creation 40 USD (covers Solana ATA rent). Reverse direction (token to USDC): requires SPL token approval to swap wallet before execute, returns 412 needs_approval if missing. Jupiter routes optimized for slippage and price. No KYC, no signup, payment via x402 USDC microtransactions on Solana mainnet.'
WHERE slug = 'suverse-solana-swap';

-- Base swap (slug = suverse-base-swap) ---------------------------------

UPDATE seller_proxy_configs
SET description = 'SuVerse Base Swap - bidirectional token swap aggregator for Base mainnet. Exchange USDC for any ERC20 token, or any ERC20 token for USDC, via LiFi routing across 20+ Base DEXs including Uniswap V3, Aerodrome, BaseSwap, SushiSwap, KyberSwap, Curve, PancakeSwap, SyncSwap. Supports memecoins BRETT, TOSHI, DEGEN, DOGINME, NORMIE and major tokens WETH, AERO, cbETH, cbBTC, USDT, USDbC, DAI, EURC. Two-step flow. Step 1 POST /v1/swap/base/quote (0.000001 USDC, 1 atomic) with body {input_token, output_token, input_amount, slippage_bps} returns quote_id, expected_output, x402_pay_url, expected_output_human, fee, total_cost, price_impact_pct, output_token metadata, route info (sushiswap, uniswap, aerodrome, etc). Step 2 POST returned x402_pay_url with x402 payment for total_cost executes the swap. Output tokens delivered to paying wallet within 30 seconds. Slippage protection with bps tolerance. 1 percent service fee. Best price routing across multiple Base DEXs aggregated by LiFi. Use cases: AI agent token swaps, automated trading bots, portfolio rebalancing, agentic DeFi, autonomous wallet operations, ERC20 conversion, stablecoin exchange, L2 token trading, DEX aggregator API, x402 swap, payable swap. Minimum swap depends on direction and router state: forward USDC to token 1.00 USD (router has allowance) or 1.10 USD (first swap), reverse token to USDC 1.50 USD (covers approve + transferFrom + swap + transfer gas). Reverse direction (token to USDC): requires ERC20 approval to swap wallet before execute, returns 412 needs_approval if missing. No KYC, no signup, payment via x402 USDC microtransactions on Base mainnet.',
    updated_at = NOW()
WHERE endpoint_slug = 'suverse-base-swap';

UPDATE catalog_listings
SET description = 'SuVerse Base Swap - bidirectional token swap aggregator for Base mainnet. Exchange USDC for any ERC20 token, or any ERC20 token for USDC, via LiFi routing across 20+ Base DEXs including Uniswap V3, Aerodrome, BaseSwap, SushiSwap, KyberSwap, Curve, PancakeSwap, SyncSwap. Supports memecoins BRETT, TOSHI, DEGEN, DOGINME, NORMIE and major tokens WETH, AERO, cbETH, cbBTC, USDT, USDbC, DAI, EURC. Two-step flow. Step 1 POST /v1/swap/base/quote (0.000001 USDC, 1 atomic) with body {input_token, output_token, input_amount, slippage_bps} returns quote_id, expected_output, x402_pay_url, expected_output_human, fee, total_cost, price_impact_pct, output_token metadata, route info (sushiswap, uniswap, aerodrome, etc). Step 2 POST returned x402_pay_url with x402 payment for total_cost executes the swap. Output tokens delivered to paying wallet within 30 seconds. Slippage protection with bps tolerance. 1 percent service fee. Best price routing across multiple Base DEXs aggregated by LiFi. Use cases: AI agent token swaps, automated trading bots, portfolio rebalancing, agentic DeFi, autonomous wallet operations, ERC20 conversion, stablecoin exchange, L2 token trading, DEX aggregator API, x402 swap, payable swap. Minimum swap depends on direction and router state: forward USDC to token 1.00 USD (router has allowance) or 1.10 USD (first swap), reverse token to USDC 1.50 USD (covers approve + transferFrom + swap + transfer gas). Reverse direction (token to USDC): requires ERC20 approval to swap wallet before execute, returns 412 needs_approval if missing. No KYC, no signup, payment via x402 USDC microtransactions on Base mainnet.'
WHERE slug = 'suverse-base-swap';

COMMIT;
