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
  // CDP is currently the only EVM facilitator we wrap. PayAI also
  // covers EVM but is intentionally NOT advertised here for v0.3.0
  // — until we have real-network data showing PayAI is a sensible
  // EVM backup, it stays Solana-only in routing.
  "eip155:8453:exact": ["coinbase-cdp"],
  "eip155:137:exact": ["coinbase-cdp"],
  "eip155:42161:exact": ["coinbase-cdp"],
  // Base Sepolia — added in v0.3.1 alongside scripts/smoke/real-evm/
  // so the same gateway binary serves the real EVM smoke without code
  // changes. CDP's `/supported` advertises eip155:84532 alongside the
  // mainnet entries.
  "eip155:84532:exact": ["coinbase-cdp"],
  // World Chain (mainnet + Sepolia) — CDP-confirmed via /supported.
  // Phase 4 block 1; no real-network smoke yet (testnet wallet on
  // World Sepolia would need separate funding).
  "eip155:480:exact": ["coinbase-cdp"],
  "eip155:4801:exact": ["coinbase-cdp"],

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
