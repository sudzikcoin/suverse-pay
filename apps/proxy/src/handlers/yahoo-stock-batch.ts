/**
 * Batch US stock quotes backed by Yahoo Finance
 * (`/v7/finance/quote?symbols=A,B,C`). Buyer pays the proxy
 * ($0.01), then we return up to 50 quotes in one upstream call.
 *
 * Yahoo's `/v7/quote` returns a `quoteResponse.result[]` array
 * with full per-symbol metadata; we keep the dozen fields a
 * portfolio dashboard reads and drop the noisy ones (analyst
 * targets, currency-symbol fonts, etc.). The fields kept are
 * stable across NYSE / NASDAQ / AMEX / OTC tickers.
 *
 * The 50-ticker ceiling is our policy, not Yahoo's (their actual
 * limit is undocumented but ~250). It's the comfortable round
 * number for a portfolio watchlist.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

interface QuoteRow {
  symbol?: string;
  shortName?: string;
  longName?: string;
  exchange?: string;
  currency?: string;
  marketState?: string;
  regularMarketPrice?: number | null;
  regularMarketChange?: number | null;
  regularMarketChangePercent?: number | null;
  regularMarketVolume?: number | null;
  regularMarketDayHigh?: number | null;
  regularMarketDayLow?: number | null;
  regularMarketPreviousClose?: number | null;
  marketCap?: number | null;
  preMarketPrice?: number | null;
  preMarketChange?: number | null;
  preMarketChangePercent?: number | null;
  postMarketPrice?: number | null;
  postMarketChange?: number | null;
  postMarketChangePercent?: number | null;
}

interface QuoteResponse {
  quoteResponse?: {
    result?: QuoteRow[];
    error?: { code?: string; description?: string } | null;
  };
}

const MAX_SYMBOLS = 50;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 10_000;

export const yahooStockBatch: InternalHandler = async (
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
    return { status: 400, body: { error: "symbols_required" } };
  }
  const obj = parsed as Record<string, unknown>;
  const symbols = obj["symbols"];
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return { status: 400, body: { error: "symbols_required" } };
  }
  if (symbols.length > MAX_SYMBOLS) {
    return { status: 400, body: { error: "too_many_symbols", max: MAX_SYMBOLS } };
  }
  if (
    !symbols.every(
      (s) => typeof s === "string" && /^[A-Za-z0-9.\-]{1,12}$/.test(s),
    )
  ) {
    return { status: 400, body: { error: "invalid_symbol_in_list" } };
  }
  const uppercased = (symbols as string[]).map((s) => s.toUpperCase());

  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(uppercased.join(","))}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": USER_AGENT },
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
  let data: QuoteResponse;
  try {
    data = (await response.json()) as QuoteResponse;
  } catch {
    return { status: 502, body: { error: "upstream_invalid_json" } };
  }

  const rows = Array.isArray(data.quoteResponse?.result)
    ? (data.quoteResponse!.result as QuoteRow[])
    : [];

  const quotes = rows.map((r) => ({
    symbol: r.symbol ?? null,
    short_name: r.shortName ?? null,
    long_name: r.longName ?? null,
    exchange: r.exchange ?? null,
    currency: r.currency ?? null,
    market_state: r.marketState ?? null,
    price: r.regularMarketPrice ?? null,
    change: r.regularMarketChange ?? null,
    change_pct: r.regularMarketChangePercent ?? null,
    volume: r.regularMarketVolume ?? null,
    day_high: r.regularMarketDayHigh ?? null,
    day_low: r.regularMarketDayLow ?? null,
    previous_close: r.regularMarketPreviousClose ?? null,
    market_cap: r.marketCap ?? null,
    pre_market_price: r.preMarketPrice ?? null,
    pre_market_change_pct: r.preMarketChangePercent ?? null,
    post_market_price: r.postMarketPrice ?? null,
    post_market_change_pct: r.postMarketChangePercent ?? null,
  }));

  const returnedSyms = new Set(quotes.map((q) => q.symbol).filter(Boolean));
  const missing = uppercased.filter((s) => !returnedSyms.has(s));

  return {
    status: 200,
    body: {
      requested: uppercased.length,
      returned: quotes.length,
      missing,
      quotes,
    },
  };
};
