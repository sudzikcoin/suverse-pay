/**
 * CDP Bazaar discovery fetcher. Paginates `/discovery/resources?limit=N&offset=M`
 * until `pagination.total` is reached or the per-call cap kicks in.
 *
 * Authentication: this endpoint is public; the gateway already authenticates
 * its OWN /verify and /settle CDP calls with a JWT (see
 * packages/adapters/coinbase-cdp), but discovery has no auth — anyone with
 * `curl` can read it.
 *
 * Soft caps:
 *   - 1000 entries per page (CDP's documented max)
 *   - 20 pages per sync (20000 entries; CDP currently has ~40k, so a partial
 *     fetch is normal — the next cron tick picks up the rest)
 *   - 1s sleep between pages (gentle on their rate limiter)
 */
import type { CatalogSource, FetchOptions, RawEndpoint } from "../types.js";

export const CDP_BAZAAR_BASE =
  "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
export const CDP_BAZAAR_ID = "cdp-bazaar";
const PAGE_SIZE = 1000;
const DEFAULT_MAX_PAGES = 20;
const PAGE_SLEEP_MS = 1000;

interface CdpResourceEntry {
  readonly resource?: string;
  readonly accepts?: ReadonlyArray<Record<string, unknown>>;
  readonly description?: string;
  readonly x402Version?: number;
  readonly extensions?: Record<string, unknown>;
  readonly quality?: Record<string, unknown>;
}

interface CdpPage {
  readonly resources?: ReadonlyArray<CdpResourceEntry>;
  readonly pagination?: { readonly total?: number; readonly offset?: number };
}

export async function fetchCdpBazaar(
  opts: FetchOptions = {},
): Promise<RawEndpoint[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxPages = opts.maxRequests ?? DEFAULT_MAX_PAGES;
  const out: RawEndpoint[] = [];

  for (let page = 0; page < maxPages; page++) {
    const offset = page * PAGE_SIZE;
    const url = `${CDP_BAZAAR_BASE}?limit=${PAGE_SIZE}&offset=${offset}`;
    let body: CdpPage;
    try {
      const res = await fetchImpl(url);
      if (!res.ok) {
        // CDP returns 429 with no body when rate-limiting; everything else is a
        // surprise. Either way, return what we have so far rather than throwing
        // away the partial result — caller logs `partial` status.
        opts.logger?.warn(`cdp-bazaar: page ${page} returned HTTP ${res.status}`, {
          page,
          status: res.status,
        });
        break;
      }
      body = (await res.json()) as CdpPage;
    } catch (err) {
      opts.logger?.warn(`cdp-bazaar: page ${page} fetch threw`, {
        page,
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }

    const resources = body.resources ?? [];
    for (const entry of resources) {
      const normalised = normaliseCdpEntry(entry);
      if (normalised !== null) out.push(normalised);
    }

    const total = body.pagination?.total ?? 0;
    if (out.length >= total) break;
    if (resources.length === 0) break;

    if (page < maxPages - 1) await sleep(PAGE_SLEEP_MS);
  }

  return out;
}

/**
 * Drop entries the upsert layer can't index: missing `resource` URL or no
 * usable `payTo` (accepts empty, or every accept has no payTo). All other
 * fields pass through verbatim so quality_signals / extensions etc are kept.
 */
function normaliseCdpEntry(e: CdpResourceEntry): RawEndpoint | null {
  if (typeof e.resource !== "string" || e.resource === "") return null;
  const accepts = Array.isArray(e.accepts) ? e.accepts : [];
  if (accepts.length === 0) return null;
  const firstPayTo = pickPayTo(accepts);
  if (firstPayTo === null) return null;
  return {
    resource: e.resource,
    payTo: firstPayTo,
    accepts,
    ...(typeof e.x402Version === "number" ? { x402Version: e.x402Version } : {}),
    ...(typeof e.description === "string" ? { description: e.description } : {}),
    ...(e.extensions !== undefined ? { extensions: e.extensions } : {}),
    ...(e.quality !== undefined ? { quality: e.quality } : {}),
    raw: e,
  };
}

function pickPayTo(
  accepts: ReadonlyArray<Record<string, unknown>>,
): string | null {
  for (const a of accepts) {
    if (typeof a["payTo"] === "string" && (a["payTo"] as string).length > 0) {
      return a["payTo"] as string;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const cdpBazaarSource: CatalogSource = {
  name: "CDP Bazaar",
  id: CDP_BAZAAR_ID,
  fetch: fetchCdpBazaar,
};
