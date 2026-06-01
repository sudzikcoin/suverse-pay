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
 *
 * Method handling:
 *   - GET / DELETE → query-shaped extension (input.queryParams, empty
 *     in v1; we have no place to capture them yet).
 *   - POST / PUT / PATCH → body-shaped extension (input.body +
 *     bodyType='json'). Requires `requestExample` to be populated —
 *     when the seller's catalog row has no sample request body, we
 *     fall back to an empty object `{}`, which keeps the route
 *     indexable but tells AI agents nothing about the request shape.
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

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
const QUERY_METHODS = new Set(["GET", "DELETE"]);

export function buildBazaarExtension(
  row: CatalogBazaarRow,
): Record<string, unknown> | null {
  const output =
    row.outputExample !== null && row.outputExample !== undefined
      ? { example: row.outputExample }
      : undefined;

  if (QUERY_METHODS.has(row.method)) {
    const config = {
      method: row.method,
      ...(output !== undefined ? { output } : {}),
    } as DiscoveryConfig;
    return declareDiscoveryExtension(config) as Record<string, unknown>;
  }

  if (BODY_METHODS.has(row.method)) {
    // Body example: prefer the seller's stored sample; fall back to
    // `{}` so the extension is still emitted (CDP requires a `body`
    // field for body-typed extensions). Empty body = indexable but
    // uninformative for agents — the seller's catalog row should
    // really set sample_request_json.
    const requestBody: Record<string, unknown> =
      row.requestExample !== null &&
      row.requestExample !== undefined &&
      typeof row.requestExample === "object" &&
      !Array.isArray(row.requestExample)
        ? (row.requestExample as Record<string, unknown>)
        : {};
    const config = {
      method: row.method,
      bodyType: "json" as const,
      input: requestBody,
      ...(output !== undefined ? { output } : {}),
    } as DiscoveryConfig;
    return declareDiscoveryExtension(config) as Record<string, unknown>;
  }

  // Unknown method (shouldn't happen — seller_proxy_configs CHECK
  // enforces the five-method set). Return null rather than guessing.
  return null;
}
