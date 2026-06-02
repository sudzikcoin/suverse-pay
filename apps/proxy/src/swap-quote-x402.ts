/**
 * x402 gate for the public-facing /v1/swap/{solana,base}/quote
 * endpoints.
 *
 * The /quote endpoint used to be free, which meant no CDP settle
 * ever fired on its URL. Coinbase Bazaar's indexer wakes only when
 * it sees a real settle against an endpoint URL, so a free /quote
 * was invisible to discovery. Pricing /quote at the cheapest
 * possible non-zero amount (1 atomic USDC = $0.000001) lets every
 * buyer's "discover via 402" call double as an indexing settle,
 * without meaningfully changing the cost of a quote.
 *
 * Two pieces live here:
 *
 *   1. The `AcceptedPayment[]` shape for each chain (Solana +
 *      Base), pinned to 1 atomic USDC.
 *   2. The `extensions.bazaar` block declaring the input + output
 *      shape so CDP's crawler indexes the endpoint with rich
 *      metadata.
 *
 * Descriptions intentionally stretch the indexable surface — they
 * pack the synonyms an AI agent might query for (memecoin sniping,
 * DEX aggregator, portfolio rebalance, x402, payable swap) so the
 * semantic search at Bazaar's discovery layer surfaces this
 * endpoint across as many natural-language queries as possible.
 */

import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { AcceptedPayment } from "@suverselabs/x402-server";

// Constants inlined rather than imported from ./swap and ./swap-base
// to keep this module a leaf. swap.ts and swap-base.ts both import
// from here, so the reverse direction would form a Node ESM cycle
// and trip TDZ during module init (the description literals are
// evaluated at top level).
/** USDC mint on Solana mainnet. Matches swap.ts USDC_MINT. */
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** CAIP-2 for Solana mainnet. Matches swap.ts SOLANA_CAIP2. */
const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
/** USDC on Base mainnet. Matches swap-base.ts USDC_BASE. */
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** CAIP-2 for Base mainnet. Matches swap-base.ts BASE_CAIP2. */
const BASE_CAIP2 = "eip155:8453";

/**
 * Per-quote fee in atomic USDC (6-decimal). Set to 1000 atomic =
 * $0.001 because CDP's hosted Solana facilitator empirically
 * rejects amounts below ~$0.001 with a 400, even though x402 spec
 * allows 1 atomic. $0.001 is still effectively free for buyers
 * and matches the rate the previous one-shot __publish endpoints
 * used to wake the same indexer.
 */
export const QUOTE_X402_AMOUNT_ATOMIC = "1000";

// --------------------------------------------------------- descriptions ----

/**
 * Public description attached to the /quote 402 challenge's
 * paymentRequirements.description field. Empirically CDP's /verify
 * schema rejects anything > 320 chars (and any non-ASCII byte —
 * em-dashes, smart quotes — same story per the
 * suverse-solana-tx-simulator incident logged in swap-publish.ts).
 * Pack the highest-value semantic-search terms first; verbose
 * documentation goes in the catalog UI instead.
 *
 * Length budget: target ≤ 300 to leave headroom for CDP's exact
 * cutoff which has drifted slightly in past schema updates.
 */
export const SOLANA_QUOTE_DESCRIPTION =
  "SuVerse Solana Swap: bidirectional USDC SPL token swap aggregator " +
  "via Jupiter v6 across Raydium, Orca, Meteora. Memecoins BONK WIF " +
  "POPCAT, majors SOL JUP JTO PYTH. POST /v1/swap/solana/quote for " +
  "quote_id; POST execute URL with x402 payment to swap. AI agent, " +
  "bot, agentic DeFi, payable swap. 1% fee.";

export const BASE_QUOTE_DESCRIPTION =
  "SuVerse Base Swap: bidirectional USDC ERC20 token swap aggregator " +
  "via LiFi across Uniswap V3, Aerodrome, BaseSwap, SushiSwap. " +
  "Memecoins BRETT TOSHI DEGEN, majors WETH AERO cbBTC. POST " +
  "/v1/swap/base/quote for quote_id; POST execute URL with x402 " +
  "payment to swap. AI agent, bot, agentic DeFi, payable swap. 1% fee.";

// --------------------------------------------------------- input examples ----

const SOLANA_QUOTE_INPUT_EXAMPLE: Record<string, unknown> = {
  input_mint: USDC_MINT,
  output_mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
  input_amount: "1000000",
  slippage_bps: 100,
};

const BASE_QUOTE_INPUT_EXAMPLE: Record<string, unknown> = {
  input_token: USDC_BASE,
  output_token: "0x4200000000000000000000000000000000000006", // WETH on Base
  input_amount: "1000000",
  slippage_bps: 100,
};

// --------------------------------------------------------- output examples ----

/**
 * Representative /quote response for the Bazaar info.output.example
 * block. Must be a JSON OBJECT — CDP's schema silently rejects
 * arrays. Values are illustrative; CDP indexes the shape, not the
 * numbers.
 */
const SOLANA_QUOTE_OUTPUT_EXAMPLE: Record<string, unknown> = {
  quote_id: "q_abc123def456",
  input_token: {
    mint: USDC_MINT,
    symbol: "USDC",
    decimals: 6,
    name: "USD Coin",
  },
  output_token: {
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    symbol: "BONK",
    decimals: 5,
    name: "Bonk",
    logoURI: "https://arweave.net/bonk-logo",
  },
  input_amount: "1000000",
  input_amount_human: "1 USDC",
  expected_output: "5977180021",
  expected_output_human: "59771.80021 BONK",
  fee: "10000",
  fee_human: "0.01 USDC",
  total_cost: "1010000",
  total_cost_human: "1.01 USDC",
  price_impact_pct: 0.026,
  expires_at: "2026-06-02T00:00:00.000Z",
  x402_pay_url:
    "https://proxy.suverse.io/v1/swap/solana/execute/q_abc123def456",
  direction: "forward",
  requires_approval: false,
  tool: "jupiter",
  service: "suverse-solana-swap",
};

const BASE_QUOTE_OUTPUT_EXAMPLE: Record<string, unknown> = {
  quote_id: "qb_abc123def456",
  input_token: {
    address: USDC_BASE,
    symbol: "USDC",
    decimals: 6,
    name: "USD Coin",
  },
  output_token: {
    address: "0x4200000000000000000000000000000000000006",
    symbol: "WETH",
    decimals: 18,
    name: "Wrapped Ether",
  },
  input_amount: "1000000",
  input_amount_human: "1 USDC",
  expected_output: "365000000000000",
  expected_output_human: "0.000365 WETH",
  fee: "10000",
  fee_human: "0.01 USDC",
  total_cost: "1010000",
  total_cost_human: "1.01 USDC",
  expires_at: "2026-06-02T00:00:00.000Z",
  x402_pay_url:
    "https://proxy.suverse.io/v1/swap/base/execute/qb_abc123def456",
  direction: "forward",
  requires_approval: false,
  tool: "lifi",
  service: "suverse-base-swap",
};

// --------------------------------------------------------- accepted payments ----

export function solanaQuoteAccepted(payTo: string): AcceptedPayment[] {
  return [
    {
      scheme: "exact",
      network: SOLANA_CAIP2,
      asset: USDC_MINT,
      payTo,
      maxAmountRequired: QUOTE_X402_AMOUNT_ATOMIC,
    },
  ];
}

export function baseQuoteAccepted(payTo: string): AcceptedPayment[] {
  return [
    {
      scheme: "exact",
      network: BASE_CAIP2,
      asset: USDC_BASE,
      payTo,
      maxAmountRequired: QUOTE_X402_AMOUNT_ATOMIC,
      extra: { name: "USD Coin", version: "2" },
    },
  ];
}

// --------------------------------------------------------- bazaar ----

type DiscoveryConfig = Parameters<typeof declareDiscoveryExtension>[0];

export function solanaQuoteBazaar(): Record<string, unknown> {
  return declareDiscoveryExtension({
    method: "POST",
    bodyType: "json" as const,
    input: SOLANA_QUOTE_INPUT_EXAMPLE,
    output: { example: SOLANA_QUOTE_OUTPUT_EXAMPLE },
  } as DiscoveryConfig) as Record<string, unknown>;
}

export function baseQuoteBazaar(): Record<string, unknown> {
  return declareDiscoveryExtension({
    method: "POST",
    bodyType: "json" as const,
    input: BASE_QUOTE_INPUT_EXAMPLE,
    output: { example: BASE_QUOTE_OUTPUT_EXAMPLE },
  } as DiscoveryConfig) as Record<string, unknown>;
}
