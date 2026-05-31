/**
 * x402.org discovery fetcher — STUB / best-effort. As of 2026-06-01 the
 * documented URL (`https://x402.org/facilitator/discovery/resources`)
 * 308-redirects to www.x402.org which 404s; no public discovery surface
 * yet exists at that origin. The source is wired here so the parser
 * already knows about it; the fetcher returns an empty list with a
 * one-time INFO at first call and a WARN on every probe error so an
 * operator can spot if/when it comes online without code changes.
 *
 * If/when x402.org publishes a JSON discovery endpoint, update
 * `X402_ORG_BASE` + the response-shape adapter and remove the stub guard.
 */
import type { CatalogSource, FetchOptions, RawEndpoint } from "../types.js";

export const X402_ORG_BASE =
  "https://x402.org/facilitator/discovery/resources";
export const X402_ORG_ID = "x402-org";

export async function fetchX402Org(
  opts: FetchOptions = {},
): Promise<RawEndpoint[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(X402_ORG_BASE);
    if (!res.ok) {
      opts.logger?.info(
        `x402-org: discovery URL not live yet (HTTP ${res.status}); skipping source`,
        { url: X402_ORG_BASE, status: res.status },
      );
      return [];
    }
    // Defensive: if/when it goes live, the response shape may not match
    // CDP's. Until we know, return empty so we don't write garbage. The
    // person who enables this should write a normaliseX402OrgEntry()
    // function similar to cdp-bazaar's and remove this guard.
    opts.logger?.warn(
      `x402-org: discovery URL responded 200 but parser is still a stub — refusing to ingest without a schema`,
      { url: X402_ORG_BASE },
    );
    return [];
  } catch (err) {
    opts.logger?.info(`x402-org: discovery URL unreachable; skipping source`, {
      url: X402_ORG_BASE,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export const x402OrgSource: CatalogSource = {
  name: "x402.org Facilitator (stub)",
  id: X402_ORG_ID,
  fetch: fetchX402Org,
};
