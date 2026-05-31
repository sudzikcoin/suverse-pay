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
// Hard ceiling so a runaway pagination loop can't DoS our process or CDP.
// 100 pages × 1000 = 100k entries; CDP's full catalog is ~40k as of
// 2026-06-01, so this is comfortable headroom. Stop conditions inside
// the loop (`out.length >= total` and `resources.length === 0`) will
// fire well before the cap for a healthy upstream.
const DEFAULT_MAX_PAGES = 100;
const PAGE_SLEEP_MS = 1000;
// Progress log cadence — every Nth page, plus the final page.
const PROGRESS_EVERY = 10;
// 429 backoff. Starts at 1s, doubles each retry, capped at 8s. After
// 5 consecutive 429s we give up on this page and return the partial.
const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 8000;
const BACKOFF_MAX_RETRIES = 5;

interface CdpResourceEntry {
  readonly resource?: string;
  readonly accepts?: ReadonlyArray<Record<string, unknown>>;
  readonly description?: string;
  readonly x402Version?: number;
  readonly extensions?: Record<string, unknown>;
  readonly quality?: Record<string, unknown>;
}

interface CdpPage {
  // CDP returns `items` on /discovery/resources but `resources` on /merchant
  // and /search. We accept either to keep the parser source-uniform.
  readonly items?: ReadonlyArray<CdpResourceEntry>;
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
    const body = await fetchPageWithBackoff(fetchImpl, url, page, opts.logger);
    if (body === null) break;

    const resources = body.items ?? body.resources ?? [];
    for (const entry of resources) {
      const normalised = normaliseCdpEntry(entry);
      if (normalised !== null) out.push(normalised);
    }

    const total = body.pagination?.total ?? 0;
    if ((page + 1) % PROGRESS_EVERY === 0 || page === maxPages - 1) {
      opts.logger?.info(
        `cdp-bazaar: page ${page + 1}/${maxPages} loaded, ${out.length}/${total} entries so far`,
        { page: page + 1, total, loaded: out.length },
      );
    }
    if (out.length >= total) break;
    if (resources.length === 0) break;

    if (page < maxPages - 1) await sleep(PAGE_SLEEP_MS);
  }

  return out;
}

/**
 * One-page fetch with 429 exponential backoff. Returns the parsed body on
 * 200, or null to signal "stop pagination here" (404/5xx, network error,
 * or backoff exhausted). The caller logs `partial` status when the pager
 * stops short of pagination.total.
 */
async function fetchPageWithBackoff(
  fetchImpl: typeof fetch,
  url: string,
  page: number,
  logger: import("../types.js").SyncLogger | undefined,
): Promise<CdpPage | null> {
  let backoff = BACKOFF_INITIAL_MS;
  for (let attempt = 0; attempt <= BACKOFF_MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url);
    } catch (err) {
      logger?.warn(`cdp-bazaar: page ${page} fetch threw`, {
        page,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (res.status === 429) {
      if (attempt === BACKOFF_MAX_RETRIES) {
        logger?.warn(`cdp-bazaar: page ${page} still 429 after ${BACKOFF_MAX_RETRIES} retries; stopping`, {
          page,
        });
        return null;
      }
      logger?.warn(`cdp-bazaar: page ${page} HTTP 429; backoff ${backoff}ms (attempt ${attempt + 1}/${BACKOFF_MAX_RETRIES})`, {
        page,
        attempt: attempt + 1,
        backoffMs: backoff,
      });
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      continue;
    }
    if (!res.ok) {
      logger?.warn(`cdp-bazaar: page ${page} returned HTTP ${res.status}; stopping`, {
        page,
        status: res.status,
      });
      return null;
    }
    try {
      return (await res.json()) as CdpPage;
    } catch (err) {
      logger?.warn(`cdp-bazaar: page ${page} JSON parse failed`, {
        page,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
  return null;
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
