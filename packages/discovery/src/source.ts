import type { DiscoveredEndpoint, SearchParams } from "./types.js";

/**
 * Contract every discovery source implements. The aggregator calls
 * `search()` on all registered sources in parallel and dedupes the
 * combined result by (resource, network, asset).
 *
 * Sources MUST be best-effort: a network failure or 4xx/5xx response
 * SHOULD return [] + log, NOT throw. Throwing kills the whole
 * aggregator's parallel call for that source slot (Promise.allSettled
 * catches it, but it's still wasted work).
 */
export interface DiscoverySource {
  /** Stable identifier — used for source-priority ranking. */
  readonly id: string;
  /** Display name for logs and debugging. */
  readonly displayName: string;
  search(params: SearchParams): Promise<DiscoveredEndpoint[]>;
}
