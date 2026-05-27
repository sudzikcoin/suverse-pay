// Phase 2 supported networks. cosmos:noble-1 (mainnet) is INTENTIONALLY
// absent — we have no funded mainnet facilitator yet. Re-add when a
// mainnet cosmos-pay deployment exists.
export const SUPPORTED_NETWORKS = [
  "cosmos:grand-1",
  "eip155:1",
  "eip155:137",
  "eip155:8453",
  "eip155:42161",
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

// Bech32 prefix per Cosmos network. All Phase 2 Cosmos networks live on
// Noble (testnet grand-1), so prefix is "noble".
export function cosmosPrefix(network: string): string {
  if (network === "cosmos:grand-1") return "noble";
  throw new Error(`no bech32 prefix configured for ${network}`);
}
