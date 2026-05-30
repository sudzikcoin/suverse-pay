/**
 * Aggregator across all enabled catalog sources. Today only Suverse
 * is wired; x402.org/ecosystem and CDP Bazaar slots are stubbed
 * (return empty + flagged not-ok) so the snapshot shape is stable
 * regardless of which sources end up reachable.
 *
 * Failures of individual sources are non-fatal: we log to stderr and
 * carry on. The whole point of the aggregator is "best effort across
 * what works". The `sources` array in the snapshot tells the agent
 * which sources contributed.
 */

import type { CatalogSnapshot, Listing } from "./types.js";
import { fetchSuverseCatalog } from "./suverse.js";

export interface AggregateOptions {
  suverseBaseUrl?: string;
  /** Per-source AbortSignal share. */
  signal?: AbortSignal;
}

export async function fetchCatalog(
  opts: AggregateOptions = {},
): Promise<CatalogSnapshot> {
  const sources: CatalogSnapshot["sources"][number][] = [];
  const listings: Listing[] = [];

  // Suverse — the canonical source for our own catalog.
  try {
    const part = await fetchSuverseCatalog({
      baseUrl: opts.suverseBaseUrl,
      signal: opts.signal,
    });
    listings.push(...part);
    sources.push({ source: "suverse", count: part.length, ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[suverse-x402-mcp] suverse catalog fetch failed:", e);
    sources.push({ source: "suverse", count: 0, ok: false });
  }

  // x402.org/ecosystem and CDP Bazaar are placeholders. Wire-up
  // happens in a follow-up — they don't yet expose a stable JSON
  // surface and scraping HTML belongs in its own module.
  sources.push({ source: "x402.org", count: 0, ok: false });
  sources.push({ source: "cdp-bazaar", count: 0, ok: false });

  return {
    listings,
    generatedAt: new Date().toISOString(),
    sources,
  };
}
