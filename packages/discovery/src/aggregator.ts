import type { DiscoverySource } from "./source.js";
import type { DiscoveredEndpoint, SearchParams } from "./types.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Source priority — earlier in the list wins ties during dedup and
 * sorts higher in source-priority secondary ordering. Sources not
 * listed here fall to the end alphabetically.
 */
const SOURCE_PRIORITY: readonly string[] = ["bazaar", "cosmos-catalog"];

interface AggregateOptions {
  /**
   * Whether to weight results by ascending estimatedPriceUsd. The
   * orchestrator/MCP tool layer is expected to set this true when
   * the user asked "cheapest first" via maxPriceUsd or an explicit
   * sort preference. Defaults to true when params.maxPriceUsd is
   * present, false otherwise.
   */
  sortByPrice?: boolean;
  /** Optional logger for one-line per-source error reports. */
  logger?: {
    warn: (msg: string, ctx?: unknown) => void;
  };
}

/**
 * Aggregate discovery results from multiple sources.
 *
 * Dedup key is the tuple `(resource, network, asset)`. Same resource
 * URL with different (network, asset) — e.g. USDC on Base AND EURC on
 * Polygon — is preserved as TWO entries, because they are operationally
 * different payment options. First-seen-wins; sources are queried in
 * registration order, so the highest-priority source's quality
 * ranking comes through for any shared option.
 *
 * Ordering after dedup:
 *   1. price ascending (if `sortByPrice` is true / maxPriceUsd given)
 *   2. source priority (bazaar > cosmos-catalog > ...)
 *   3. discoveredAt descending (recency)
 *
 * Then `limit` is applied (default 20, hard cap 100).
 *
 * Resilience: Promise.allSettled — one source throwing or hanging
 * does NOT kill the whole query. Failed sources are logged and
 * skipped; surviving sources still return data.
 */
export async function aggregate(
  sources: readonly DiscoverySource[],
  params: SearchParams,
  options: AggregateOptions = {},
): Promise<DiscoveredEndpoint[]> {
  const sortByPrice = options.sortByPrice ?? params.maxPriceUsd !== undefined;
  const logger = options.logger ?? {
    warn: (m, c) => console.warn(`[discovery.aggregator] ${m}`, c ?? ""),
  };

  const settled = await Promise.allSettled(
    sources.map(async (s) => ({ id: s.id, results: await s.search(params) })),
  );

  // Preserve source order (registration order) so that, on dedup
  // collisions, the earlier-registered source wins.
  const flat: DiscoveredEndpoint[] = [];
  for (let i = 0; i < settled.length; i += 1) {
    const result = settled[i];
    const source = sources[i];
    if (result === undefined || source === undefined) continue;
    if (result.status === "fulfilled") {
      flat.push(...result.value.results);
    } else {
      logger.warn(`source ${source.id} failed`, {
        reason:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
    }
  }

  // Dedup by (resource, network, asset) — first occurrence wins.
  // Same URL with different (network, asset) is preserved.
  const seen = new Map<string, DiscoveredEndpoint>();
  for (const entry of flat) {
    const key = dedupKey(entry);
    if (!seen.has(key)) {
      seen.set(key, entry);
    }
  }
  const deduped = Array.from(seen.values());

  deduped.sort((a, b) => {
    if (sortByPrice) {
      const priceDelta = comparePrice(a.estimatedPriceUsd, b.estimatedPriceUsd);
      if (priceDelta !== 0) return priceDelta;
    }
    const sourceDelta = sourcePriorityRank(a.sourceId) - sourcePriorityRank(b.sourceId);
    if (sourceDelta !== 0) return sourceDelta;
    // Recency: newer discoveredAt first.
    if (a.discoveredAt < b.discoveredAt) return 1;
    if (a.discoveredAt > b.discoveredAt) return -1;
    return 0;
  });

  const limit = clampLimit(params.limit);
  return deduped.slice(0, limit);
}

export function dedupKey(entry: Pick<DiscoveredEndpoint, "resource" | "network" | "asset">): string {
  return `${entry.resource}|${entry.network}|${entry.asset.toLowerCase()}`;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function sourcePriorityRank(sourceId: string): number {
  const idx = SOURCE_PRIORITY.indexOf(sourceId);
  // Unknown sources sort after known ones, ordered alphabetically.
  return idx >= 0 ? idx : SOURCE_PRIORITY.length + sourceId.charCodeAt(0);
}

function comparePrice(a: string | undefined, b: string | undefined): number {
  // Entries with a known price come first; entries without rank last
  // so unknown-price options don't crowd out known-cheap ones.
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const aNum = Number.parseFloat(a);
  const bNum = Number.parseFloat(b);
  if (Number.isNaN(aNum) && Number.isNaN(bNum)) return 0;
  if (Number.isNaN(aNum)) return 1;
  if (Number.isNaN(bNum)) return -1;
  return aNum - bNum;
}
