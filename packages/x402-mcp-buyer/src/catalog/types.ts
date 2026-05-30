/**
 * Normalised listing shape — what the MCP exposes to the LLM. We
 * intentionally don't surface every internal field from
 * catalog_listings; the agent only needs enough to decide whether
 * to call the endpoint and at what price.
 *
 * `priceAtomicMin/Max` are NUMERIC(78,0) on the server so they
 * arrive as strings — keep them as strings here to avoid silently
 * losing precision on the BigInt → Number boundary.
 */
export interface Listing {
  id: string;
  source: "suverse";
  title: string;
  description: string;
  endpointUrl: string;
  category: string;
  tags: ReadonlyArray<string>;
  /** Atomic units of the listing's price-unit (typically USDC: 6 decimals). */
  priceAtomicMin: string;
  priceAtomicMax: string;
  priceUnit: string;
  networks: ReadonlyArray<string>;
  regions: ReadonlyArray<string>;
  isVerified: boolean;
  homepageUrl: string | null;
  documentationUrl: string | null;
}

export interface CatalogSnapshot {
  listings: ReadonlyArray<Listing>;
  generatedAt: string;
  sources: ReadonlyArray<{ source: string; count: number; ok: boolean }>;
}
