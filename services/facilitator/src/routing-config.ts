/**
 * Routing priority for /facilitator/settle.
 *
 * Keyed by `${network}:${scheme}`. Value is an ordered list of
 * adapter ids — the first id is the primary; subsequent are
 * tried on retryable errors from the primary.
 *
 * Today the table is static. Phase 4+ TODO: hot-reload from a
 * `routing_config.json` file so operators can adjust failover order
 * without redeploying (already-running settles aren't affected
 * because each settle reads the snapshot once at request entry).
 *
 * Devnet/testnet routes are present alongside mainnet so the same
 * gateway binary can serve test environments without code changes.
 */
export type RoutingPriority = ReadonlyArray<string>;

export const ROUTING_CONFIG: Readonly<Record<string, RoutingPriority>> = {
  // ---- Cosmos -------------------------------------------------------
  "cosmos:grand-1:exact_cosmos_authz": ["cosmos-pay"],

  // ---- EVM ----------------------------------------------------------
  // CDP-primary networks. PayAI added as failover in Phase 4 Block 1
  // Sub-task 2 for every (network, scheme) pair that BOTH adapters
  // advertise — gives the gateway a real second EVM facilitator
  // without new adapter code.
  "eip155:8453:exact":  ["coinbase-cdp", "payai"],
  "eip155:137:exact":   ["coinbase-cdp", "payai"],
  "eip155:42161:exact": ["coinbase-cdp", "payai"],
  // Base Sepolia — added in v0.3.1 alongside scripts/smoke/real-evm/
  // so the same gateway binary serves the real EVM smoke without code
  // changes. CDP's `/supported` advertises eip155:84532 alongside the
  // mainnet entries. PayAI also covers Base Sepolia → failover.
  "eip155:84532:exact": ["coinbase-cdp", "payai"],
  // World Chain (mainnet + Sepolia) — CDP-confirmed via /supported,
  // NOT in PayAI's EVM list — CDP-only routes.
  "eip155:480:exact":  ["coinbase-cdp"],
  "eip155:4801:exact": ["coinbase-cdp"],
  // PayAI-exclusive EVM routes (Phase 4 Block 1 Sub-task 2). CDP
  // does NOT advertise these networks on x402; PayAI does. No
  // failover (single adapter), but routed cleanly through the same
  // /facilitator/settle surface as everything else.
  "eip155:43114:exact":  ["payai"], // Avalanche C-Chain mainnet
  "eip155:43113:exact":  ["payai"], // Avalanche Fuji testnet
  "eip155:421614:exact": ["payai"], // Arbitrum Sepolia testnet

  // ---- Solana mainnet (CDP primary, PayAI failover) -----------------
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:exact": ["coinbase-cdp", "payai"],

  // ---- Solana devnet (PayAI only) -----------------------------------
  // PayAI's /supported advertises both v1 ("solana-devnet") and v2
  // ("solana:Etwt...") entries; we route the v2 form. Useful for
  // Sub-task 7 real smoke without burning mainnet USDC.
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:exact": ["payai"],
};

export function routingKey(network: string, scheme: string): string {
  return `${network}:${scheme}`;
}

export function getRoutingPriority(
  network: string,
  scheme: string,
): RoutingPriority | undefined {
  return ROUTING_CONFIG[routingKey(network, scheme)];
}
