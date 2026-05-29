/**
 * Canonical Permit2 + x402ExactPermit2Proxy addresses and EIP-712
 * domain helpers. Phase 4 Block 2 Sub-task 6.
 *
 * Both contracts are deployed at the same address across every
 * supported EVM chain via CREATE2:
 *   - Permit2:                 0x000000000022D473030F116dDEE9F6B43aC78BA3
 *   - x402ExactPermit2Proxy:   0x402085c248EeA27D92E8b30b2C58ed07f9E20001
 *
 * Deployment verified 2026-05-29 via eth_getCode against these
 * mainnets (17 EVM total): Ethereum, Optimism, XDC, BNB Chain
 * (Sub-task 7), Polygon, Monad, Sonic, World Chain, Sei, Abstract,
 * IoTeX, Base, Arbitrum, Celo, Avalanche, Ink, Linea. All 17 have
 * the Permit2 contract; the x402ExactPermit2Proxy is present on 12
 * (the five missing are Sonic 146, Abstract 2741, IoTeX 4689, Ink
 * 57073, Linea 59144 — settle through the x402 proxy will revert
 * there until upstream deploys; client-side Permit2 signing still
 * produces a valid signature, the proxy deployment is a settlement-
 * side concern).
 *
 * Critical Permit2 quirk: the EIP-712 domain has NO `version` field.
 * Permit2's `DOMAIN_SEPARATOR()` is computed as
 *   keccak256(abi.encode(
 *     keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
 *     keccak256("Permit2"),
 *     block.chainid,
 *     address(this)
 *   ))
 * — three fields, not four. Most EIP-712 helpers accept `version: undefined`
 * to omit it; viem's signTypedData does. Do NOT add a synthetic
 * version ("1" or "2"); the hash will diverge from on-chain.
 */

/** Permit2 canonical contract — same on every EVM chain. */
export const PERMIT2_CONTRACT_ADDRESS =
  "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

/**
 * x402ExactPermit2Proxy canonical address — the spender field in
 * every x402 Permit2 signature. The proxy validates Witness data and
 * forwards to Permit2.
 */
export const X402_EXACT_PERMIT2_PROXY_ADDRESS =
  "0x402085c248EeA27D92E8b30b2C58ed07f9E20001" as const;

/**
 * EVM chains where Permit2 (the underlying contract) is deployed.
 * Client-side signing requires this AND that the chain has a USDC/
 * USDT/etc. contract operators want to spend.
 */
export const PERMIT2_DEPLOYED_CHAIN_IDS = [
  1,       // Ethereum mainnet
  10,      // Optimism mainnet
  50,      // XDC
  56,      // BNB Chain (Phase 4 Block 2 Sub-task 7)
  137,     // Polygon
  143,     // Monad mainnet
  146,     // Sonic
  480,     // World Chain mainnet
  1329,    // Sei mainnet
  2741,    // Abstract
  4689,    // IoTeX
  8453,    // Base mainnet
  42161,   // Arbitrum mainnet
  42220,   // Celo
  43114,   // Avalanche C-Chain
  57073,   // Ink
  59144,   // Linea
] as const;

/**
 * EVM chains where BOTH Permit2 AND the x402ExactPermit2Proxy are
 * deployed. This is the subset where a Permit2 signature produced by
 * `signPermit2Authorization` can actually settle via x402 today.
 * The other chains (Sonic 146, Abstract 2741, IoTeX 4689, Ink 57073,
 * Linea 59144) require the upstream proxy deployment to land first.
 */
export const X402_PERMIT2_SETTLABLE_CHAIN_IDS = [
  1,       // Ethereum mainnet
  10,      // Optimism mainnet
  50,      // XDC
  56,      // BNB Chain (Sub-task 7)
  137,     // Polygon
  143,     // Monad mainnet
  480,     // World Chain mainnet
  1329,    // Sei mainnet
  8453,    // Base mainnet
  42161,   // Arbitrum mainnet
  42220,   // Celo
  43114,   // Avalanche C-Chain
] as const;

export type Permit2ChainId = (typeof PERMIT2_DEPLOYED_CHAIN_IDS)[number];
export type X402Permit2SettlableChainId =
  (typeof X402_PERMIT2_SETTLABLE_CHAIN_IDS)[number];

export function isPermit2ChainId(n: number): n is Permit2ChainId {
  return (PERMIT2_DEPLOYED_CHAIN_IDS as readonly number[]).includes(n);
}

export function isX402Permit2SettlableChainId(
  n: number,
): n is X402Permit2SettlableChainId {
  return (X402_PERMIT2_SETTLABLE_CHAIN_IDS as readonly number[]).includes(n);
}

/**
 * viem-compatible domain object for Permit2 on a given chain. Note
 * the deliberate absence of `version` — see the file header for why.
 */
export function buildPermit2Domain(chainId: number) {
  return {
    name: "Permit2",
    chainId,
    verifyingContract: PERMIT2_CONTRACT_ADDRESS,
  } as const;
}
