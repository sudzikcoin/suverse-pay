import { SOLANA_DEVNET, SOLANA_MAINNET } from "@suverse-pay/signer-solana";

// Phase 3 supported networks.
//
// cosmos:noble-1 (Cosmos mainnet) remains INTENTIONALLY absent — no
// funded mainnet facilitator yet. Re-add when a mainnet cosmos-pay
// deployment exists.
//
// Solana support added in Sub-task 6:
//   - SOLANA_MAINNET — settle requires either a Coinbase CDP API key
//     (Phase 3 Sub-task 4) or PayAI mainnet (live, costs real money).
//   - SOLANA_DEVNET  — fully end-to-end testable via PayAI devnet
//     (no API key, no real money).
export const SUPPORTED_NETWORKS = [
  "cosmos:grand-1",
  "eip155:1",
  "eip155:137",
  "eip155:8453",
  "eip155:42161",
  SOLANA_MAINNET,
  SOLANA_DEVNET,
] as const;

export type SupportedNetwork = (typeof SUPPORTED_NETWORKS)[number];

export function isSupportedNetwork(n: string): n is SupportedNetwork {
  return (SUPPORTED_NETWORKS as readonly string[]).includes(n);
}

export function isCosmosNetwork(n: string): boolean {
  return n.startsWith("cosmos:");
}

export function isEvmNetwork(n: string): boolean {
  return n.startsWith("eip155:");
}

export function isSolanaNetwork(n: string): boolean {
  return n.startsWith("solana:");
}

/**
 * Signer family for a CAIP-2 network. Drives dispatch in init_session
 * (address derivation) and pay_and_call (payload signing). Adding a
 * new chain family (Aptos, Sui, TON) is a single-line change here plus
 * a new signer-{family} package.
 */
export type SignerFamily = "cosmos" | "evm" | "solana";

export function selectSigner(network: string): SignerFamily {
  if (isCosmosNetwork(network)) return "cosmos";
  if (isEvmNetwork(network)) return "evm";
  if (isSolanaNetwork(network)) return "solana";
  throw new Error(`no signer family configured for network: ${network}`);
}

// Bech32 prefix per Cosmos network. All Phase 2 Cosmos networks live on
// Noble (testnet grand-1), so prefix is "noble".
export function cosmosPrefix(network: string): string {
  if (network === "cosmos:grand-1") return "noble";
  throw new Error(`no bech32 prefix configured for ${network}`);
}
