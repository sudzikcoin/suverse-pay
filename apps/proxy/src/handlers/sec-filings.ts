/**
 * Recent SEC EDGAR filings backed by `data.sec.gov/submissions`.
 * Buyer pays the proxy ($0.01). Two-call upstream:
 *   1. Resolve ticker → CIK via the small public mapping at
 *      sec.gov/files/company_tickers.json (cached in memory for
 *      24h — see CIK_CACHE_TTL_MS).
 *   2. Fetch `submissions/CIK{padded-10}.json` and surface the
 *      most-recent filings with form, filing date, accession,
 *      primary-document URL.
 *
 * SEC's terms-of-service require a custom User-Agent string
 * including a contact email. We send a SuVerse-identified UA;
 * SEC's enforcement is real (10req/sec rate limit + UA check).
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

interface TickerMapEntry {
  cik_str?: number;
  ticker?: string;
  title?: string;
}

interface SubmissionsResponse {
  cik?: string;
  name?: string;
  tickers?: string[];
  exchanges?: string[];
  filings?: {
    recent?: {
      accessionNumber?: string[];
      filingDate?: string[];
      reportDate?: string[];
      form?: string[];
      primaryDocument?: string[];
      primaryDocDescription?: string[];
      isXBRL?: number[];
    };
  };
}

const USER_AGENT = "SuVerse Research contact@suverse.io";
const TIMEOUT_MS = 10_000;
const CIK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

interface CikCache {
  loadedAt: number;
  byTicker: Map<string, { cik: string; title: string }>;
}
let cikCache: CikCache | null = null;

async function loadCikCache(
  fetchImpl: typeof fetch,
): Promise<Map<string, { cik: string; title: string }>> {
  const now = Date.now();
  if (cikCache && now - cikCache.loadedAt < CIK_CACHE_TTL_MS) {
    return cikCache.byTicker;
  }
  const url = "https://www.sec.gov/files/company_tickers.json";
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`ticker-map-fetch-failed:${response.status}`);
  }
  const raw = (await response.json()) as Record<string, TickerMapEntry>;
  const byTicker = new Map<string, { cik: string; title: string }>();
  for (const [, entry] of Object.entries(raw)) {
    if (typeof entry.cik_str === "number" && typeof entry.ticker === "string") {
      const padded = String(entry.cik_str).padStart(10, "0");
      byTicker.set(entry.ticker.toUpperCase(), {
        cik: padded,
        title: entry.title ?? "",
      });
    }
  }
  cikCache = { loadedAt: now, byTicker };
  return byTicker;
}

// Exposed for tests so they can pre-seed the cache and skip the
// 5MB upstream pull. Production code never calls this.
export function _setCikCacheForTests(
  entries: Array<{ ticker: string; cik: string; title?: string }>,
): void {
  const map = new Map<string, { cik: string; title: string }>();
  for (const e of entries) {
    map.set(e.ticker.toUpperCase(), { cik: e.cik, title: e.title ?? "" });
  }
  cikCache = { loadedAt: Date.now(), byTicker: map };
}

export function _clearCikCacheForTests(): void {
  cikCache = null;
}

export const secFilings: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  let parsed: unknown;
  try {
    parsed =
      input.body && input.body.length > 0
        ? JSON.parse(input.body.toString("utf8"))
        : null;
  } catch {
    return { status: 400, body: { error: "invalid_json_body" } };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { status: 400, body: { error: "ticker_required" } };
  }
  const obj = parsed as Record<string, unknown>;
  const ticker = obj["ticker"];
  if (typeof ticker !== "string" || ticker.length === 0) {
    return { status: 400, body: { error: "ticker_required" } };
  }
  if (!/^[A-Za-z0-9.\-]{1,12}$/.test(ticker)) {
    return { status: 400, body: { error: "invalid_ticker_format" } };
  }
  const upperTicker = ticker.toUpperCase();
  let limit = DEFAULT_LIMIT;
  const rawLimit = obj["limit"];
  if (rawLimit !== undefined) {
    if (
      typeof rawLimit !== "number" ||
      !Number.isInteger(rawLimit) ||
      rawLimit < 1
    ) {
      return { status: 400, body: { error: "invalid_limit" } };
    }
    limit = Math.min(rawLimit, MAX_LIMIT);
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  let cikMap: Map<string, { cik: string; title: string }>;
  try {
    cikMap = await loadCikCache(fetchImpl);
  } catch (err) {
    return {
      status: 502,
      body: { error: "ticker_map_unavailable", reason: (err as Error).message },
    };
  }
  const entry = cikMap.get(upperTicker);
  if (!entry) {
    return { status: 404, body: { error: "ticker_not_found", ticker: upperTicker } };
  }

  const url = `https://data.sec.gov/submissions/CIK${entry.cik}.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") {
      return { status: 504, body: { error: "upstream_timeout" } };
    }
    return { status: 502, body: { error: "upstream_unreachable" } };
  }
  clearTimeout(timer);

  if (response.status === 429) {
    return { status: 503, body: { error: "rate_limit_upstream" } };
  }
  if (!response.ok) {
    return { status: 502, body: { error: "upstream_error", upstreamStatus: response.status } };
  }

  let data: SubmissionsResponse;
  try {
    data = (await response.json()) as SubmissionsResponse;
  } catch {
    return { status: 502, body: { error: "upstream_invalid_json" } };
  }
  const recent = data.filings?.recent;
  if (!recent) {
    return { status: 502, body: { error: "no_recent_filings_block" } };
  }
  const n = Math.min(limit, recent.form?.length ?? 0);
  const filings = [];
  for (let i = 0; i < n; i++) {
    const accession = recent.accessionNumber?.[i] ?? "";
    const accessionNoDash = accession.replace(/-/g, "");
    const primaryDoc = recent.primaryDocument?.[i] ?? "";
    const filingUrl =
      accession && primaryDoc
        ? `https://www.sec.gov/Archives/edgar/data/${Number.parseInt(entry.cik, 10)}/${accessionNoDash}/${primaryDoc}`
        : null;
    filings.push({
      form: recent.form?.[i] ?? null,
      filing_date: recent.filingDate?.[i] ?? null,
      report_date: recent.reportDate?.[i] ?? null,
      accession_number: accession || null,
      primary_document: primaryDoc || null,
      primary_doc_description: recent.primaryDocDescription?.[i] ?? null,
      is_xbrl: recent.isXBRL?.[i] === 1,
      filing_url: filingUrl,
    });
  }

  return {
    status: 200,
    body: {
      ticker: upperTicker,
      cik: entry.cik,
      name: data.name ?? entry.title,
      tickers: data.tickers ?? [upperTicker],
      exchanges: data.exchanges ?? [],
      count: filings.length,
      filings,
    },
  };
};
