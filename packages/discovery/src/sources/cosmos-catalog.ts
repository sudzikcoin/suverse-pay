import type { DiscoverySource } from "../source.js";
import type { DiscoveredEndpoint, SearchParams } from "../types.js";

/**
 * Placeholder catalog for Cosmos-native paid endpoints (cosmos-pay
 * facilitator). Bazaar indexes only endpoints settled through CDP
 * Facilitator, so anything Cosmos-native is invisible to Bazaar.
 *
 * Phase 2 scope: structural only — returns an empty array. The
 * interface is fixed so the aggregator can include this source today
 * and have something real to call when sellers start registering.
 *
 * Phase 3+ implementation will likely:
 *   - maintain a seller registry (on-chain contract or signed JSON
 *     manifests published by sellers)
 *   - query cosmos-pay's `/supported` to filter advertised options
 *     against the facilitator's currently-supported (network, denom,
 *     scheme) set
 *
 * Until then, leave this as a no-op. Aggregator dedup logic and
 * source-priority ordering are exercised regardless because Bazaar
 * still returns rows.
 */
export class CosmosCatalogSource implements DiscoverySource {
  readonly id = "cosmos-catalog";
  readonly displayName = "Cosmos Catalog";

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async search(_params: SearchParams): Promise<DiscoveredEndpoint[]> {
    return [];
  }
}
