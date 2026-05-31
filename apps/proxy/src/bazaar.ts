/**
 * Build the `extensions.bazaar` block attached to the proxy's 402
 * challenge body. Read by the Coinbase Bazaar crawler
 * (`CoinbaseBazaarDiscovery/*`), which hits the live 402, extracts
 * the bazaar info, and catalogs the endpoint under the seller's
 * payTo address.
 *
 * Indexing requirements (per docs.cdp.coinbase.com/x402/bazaar +
 * empirical findings logged in the GovHub bazaar v2 migration):
 *
 *   1. Challenge must be clean x402Version 2 (we are; per handler).
 *   2. Top-level `extensions.bazaar = { info, schema }` present.
 *   3. At least one CDP-routed settle on the resource URL, so the
 *      crawler is woken up.
 *
 * Returns null when the route has no approved catalog listing — the
 * proxy still serves the 402 (no `extensions` field at all), but
 * CDP's crawler will skip it. That matches our policy of advertising
 * only approved listings to discovery surfaces.
 */

import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { CatalogBazaarRow } from "./store.js";

/**
 * The published d.ts strips `method` via `DistributiveOmit` even
 * though the runtime accepts it. Cast through `Record<string,
 * unknown>` to forward the method without lying about the typed
 * config — verified against the package's actual createQuery /
 * createBodyDiscoveryExtension implementations.
 */
type DiscoveryConfig = Parameters<typeof declareDiscoveryExtension>[0] & {
  method?: string;
};

export function buildBazaarExtension(
  row: CatalogBazaarRow,
): Record<string, unknown> | null {
  // Body methods (POST/PUT/PATCH) require a `bodyType` + sample
  // body that we don't capture for self-serve proxies yet. Only
  // query methods (GET/DELETE) flow through here.
  if (row.method !== "GET" && row.method !== "DELETE") {
    return null;
  }
  const output =
    row.outputExample !== null && row.outputExample !== undefined
      ? { example: row.outputExample }
      : undefined;
  const config = {
    method: row.method,
    ...(output !== undefined ? { output } : {}),
  } as DiscoveryConfig;
  return declareDiscoveryExtension(config) as Record<string, unknown>;
}
