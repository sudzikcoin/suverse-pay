// Normalized discovery types. Provider-agnostic — each source maps its
// native response shape to this contract.

export interface SearchParams {
  /** Free-text semantic search across resource description / tags. */
  query?: string;
  /** CAIP-2 network id, e.g. "eip155:8453", "cosmos:noble-1". */
  network?: string;
  /** Asset filter — contract address or symbol, source-specific. */
  asset?: string;
  /** Payment scheme, e.g. "exact", "exact_cosmos_authz". */
  scheme?: string;
  /** Filter by merchant recipient address. */
  payTo?: string;
  /** Maximum acceptable price in USD. Decimal string, e.g. "1.50". */
  maxPriceUsd?: string;
  /**
   * Max results to return after dedup + ranking. Default 20, hard
   * capped at 100 by the aggregator. Individual sources may apply
   * their own per-source caps (Bazaar's per-call cap is 20).
   */
  limit?: number;
}

/**
 * A single paid x402 endpoint as advertised by a discovery source.
 *
 * One resource URL with N payment options (different network/asset
 * pairs) is represented as N separate DiscoveredEndpoint entries —
 * the agent should see each as a distinct option since payment
 * mechanics differ.
 */
export interface DiscoveredEndpoint {
  /** Resource URL (the paid endpoint itself). */
  resource: string;
  /** Optional human-readable description. */
  description?: string;
  /** CAIP-2 network id for this payment option. */
  network: string;
  /** Asset identifier (contract address on EVM, denom or mint on Cosmos/Solana). */
  asset: string;
  /** Payment scheme this option uses. */
  scheme: string;
  /** Raw amount in the asset's base units (decimal string). */
  amount: string;
  /**
   * Best-effort USD estimate computed from `amount` + asset decimals
   * for known stablecoins (USDC, EURC, USDT — all 6 decimals). Omitted
   * for unknown assets. Sources MAY override with a native value.
   */
  estimatedPriceUsd?: string;
  /** Merchant recipient address. */
  payTo: string;
  /** Max signature validity window. Optional — sources may omit. */
  maxTimeoutSeconds?: number;
  /** Which DiscoverySource produced this entry. */
  sourceId: string;
  /** ISO timestamp when WE retrieved this entry (not when source last updated). */
  discoveredAt: string;
  /** Source-specific extras (tags, serviceName, mimeType, quality stats). */
  metadata?: Record<string, unknown>;
}
