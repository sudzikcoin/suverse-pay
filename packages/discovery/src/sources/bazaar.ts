import { z } from "zod";
import type { DiscoverySource } from "../source.js";
import type { DiscoveredEndpoint, SearchParams } from "../types.js";

export const BAZAAR_DEFAULT_BASE_URL =
  "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search";

/** Bazaar's per-call hard cap, documented at the time of writing. */
export const BAZAAR_MAX_LIMIT = 20;

/** Per-request HTTP timeout. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Exponential backoff for 429 responses: 1s, 2s, 4s. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

/**
 * Default stablecoin decimals map. Used to compute estimatedPriceUsd
 * from Bazaar's raw `amount` field for the common case where the
 * asset is a stablecoin pegged 1:1 to USD. Unknown assets get no
 * estimatedPriceUsd — caller is responsible.
 *
 * Keyed by lowercased contract address. Symbol-keyed entries cover
 * the case where Bazaar returns a symbol instead of an address.
 */
const STABLECOIN_DECIMALS: Record<string, number> = {
  // USDC native deployments — 6 decimals
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 6, // Base
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": 6, // Polygon
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831": 6, // Arbitrum
  // EURC on Base — 6 decimals
  "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42": 6,
  // Symbol fallbacks
  usdc: 6,
  eurc: 6,
  usdt: 6,
};

const BazaarAcceptsItemSchema = z
  .object({
    scheme: z.string(),
    network: z.string(),
    asset: z.string(),
    amount: z.string(),
    payTo: z.string(),
    maxTimeoutSeconds: z.number().optional(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    resource: z.string().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const BazaarResourceSchema = z
  .object({
    resource: z.string(),
    type: z.string().optional(),
    x402Version: z.number().optional(),
    description: z.string().optional(),
    lastUpdated: z.string().optional(),
    serviceName: z.string().optional(),
    tags: z.array(z.string()).optional(),
    accepts: z.array(BazaarAcceptsItemSchema),
    quality: z.record(z.string(), z.unknown()).optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const BazaarResponseSchema = z.object({
  resources: z.array(BazaarResourceSchema),
  partialResults: z.boolean().optional(),
  searchMethod: z.string().optional(),
  x402Version: z.number().optional(),
});

export type BazaarResponse = z.infer<typeof BazaarResponseSchema>;

export interface BazaarAdapterConfig {
  /** Override the API base URL. Used by tests. */
  baseUrl?: string;
  /** Override fetch implementation. Used by tests. */
  fetchImpl?: typeof fetch;
  /** Override timeout. Default 10s. */
  timeoutMs?: number;
  /** Override retry delays for 429. */
  retryDelaysMs?: number[];
  /** Optional logger — defaults to console.warn / console.debug. */
  logger?: {
    warn: (msg: string, ctx?: unknown) => void;
    debug?: (msg: string, ctx?: unknown) => void;
  };
}

function estimatedPriceUsdFor(
  asset: string,
  amount: string,
): string | undefined {
  const key = asset.toLowerCase();
  const decimals = STABLECOIN_DECIMALS[key];
  if (decimals === undefined) return undefined;
  // Parse via bigint to avoid float precision loss on large stablecoin amounts.
  let raw: bigint;
  try {
    raw = BigInt(amount);
  } catch {
    return undefined;
  }
  if (raw < 0n) return undefined;
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const fraction = raw % divisor;
  if (fraction === 0n) return whole.toString();
  const fractionStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fractionStr.length > 0 ? `${whole}.${fractionStr}` : whole.toString();
}

function buildQueryString(params: SearchParams): string {
  const search = new URLSearchParams();
  if (params.query !== undefined) search.set("query", params.query);
  if (params.network !== undefined) search.set("network", params.network);
  if (params.asset !== undefined) search.set("asset", params.asset);
  if (params.scheme !== undefined) search.set("scheme", params.scheme);
  if (params.payTo !== undefined) search.set("payTo", params.payTo);
  if (params.maxPriceUsd !== undefined) search.set("maxUsdPrice", params.maxPriceUsd);
  if (params.limit !== undefined) {
    const capped = Math.min(Math.max(1, Math.floor(params.limit)), BAZAAR_MAX_LIMIT);
    search.set("limit", capped.toString());
  }
  const qs = search.toString();
  return qs.length > 0 ? `?${qs}` : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bazaar discovery source — wraps Coinbase's public no-auth
 * /v2/x402/discovery/search endpoint.
 *
 * Notes on coverage: Bazaar indexes ONLY endpoints settled through
 * CDP Facilitator. Cosmos-native endpoints (via cosmos-pay) will NOT
 * appear here. That gap is filled by cosmos-catalog (placeholder
 * today, populated as cosmos-pay sellers register in Phase 3+).
 */
export class BazaarSource implements DiscoverySource {
  readonly id = "bazaar";
  readonly displayName = "Coinbase Bazaar";

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: number[];
  private readonly logger: NonNullable<BazaarAdapterConfig["logger"]>;

  constructor(config: BazaarAdapterConfig = {}) {
    this.baseUrl = config.baseUrl ?? BAZAAR_DEFAULT_BASE_URL;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelaysMs = config.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.logger = config.logger ?? {
      warn: (m, c) => console.warn(`[bazaar] ${m}`, c ?? ""),
      debug: () => {},
    };
  }

  async search(params: SearchParams): Promise<DiscoveredEndpoint[]> {
    const url = `${this.baseUrl}${buildQueryString(params)}`;
    const discoveredAt = new Date().toISOString();
    const raw = await this.fetchWithRetry(url);
    if (raw === null) return [];

    const parsed = BazaarResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn("response did not match expected schema", {
        issues: parsed.error.issues.slice(0, 5),
      });
      return [];
    }

    const out: DiscoveredEndpoint[] = [];
    for (const resource of parsed.data.resources) {
      // Each accepts entry becomes a SEPARATE DiscoveredEndpoint —
      // they're operationally different payment options for the same
      // URL (different network/asset/scheme).
      for (const accept of resource.accepts) {
        const estimated = estimatedPriceUsdFor(accept.asset, accept.amount);
        const metadata: Record<string, unknown> = {};
        if (resource.serviceName !== undefined) metadata.serviceName = resource.serviceName;
        if (resource.tags !== undefined) metadata.tags = resource.tags;
        if (resource.quality !== undefined) metadata.quality = resource.quality;
        if (resource.lastUpdated !== undefined) metadata.lastUpdated = resource.lastUpdated;
        if (accept.mimeType !== undefined) metadata.mimeType = accept.mimeType;
        if (accept.extra !== undefined) metadata.extra = accept.extra;

        out.push({
          resource: resource.resource,
          description: accept.description ?? resource.description,
          network: accept.network,
          asset: accept.asset,
          scheme: accept.scheme,
          amount: accept.amount,
          ...(estimated !== undefined && { estimatedPriceUsd: estimated }),
          payTo: accept.payTo,
          ...(accept.maxTimeoutSeconds !== undefined && {
            maxTimeoutSeconds: accept.maxTimeoutSeconds,
          }),
          sourceId: this.id,
          discoveredAt,
          ...(Object.keys(metadata).length > 0 && { metadata }),
        });
      }
    }
    return out;
  }

  private async fetchWithRetry(url: string): Promise<unknown | null> {
    let attempt = 0;
    // Number of total attempts = retry delays + 1 (initial).
    const maxAttempts = this.retryDelaysMs.length + 1;
    while (attempt < maxAttempts) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (response.status === 429) {
          const delay = this.retryDelaysMs[attempt];
          if (delay !== undefined && attempt < this.retryDelaysMs.length) {
            this.logger.warn(`429 rate limited, retry in ${delay}ms`, { attempt });
            await sleep(delay);
            attempt += 1;
            continue;
          }
          this.logger.warn("429 rate limited, retries exhausted", { url });
          return null;
        }
        if (!response.ok) {
          this.logger.warn(`http ${response.status}`, { url });
          return null;
        }
        const json: unknown = await response.json();
        return json;
      } catch (err) {
        const isAbort = err instanceof Error && err.name === "AbortError";
        const reason = isAbort ? "timeout" : "network error";
        this.logger.warn(`${reason} fetching bazaar`, {
          url,
          message: err instanceof Error ? err.message : String(err),
        });
        return null;
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }
}
