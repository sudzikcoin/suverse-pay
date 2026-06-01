/**
 * Single US stock quote backed by Yahoo Finance
 * (`/v8/finance/chart/{symbol}`). Buyer pays the proxy ($0.005),
 * then we return the latest price + the day's OHLCV + 52w hi/lo +
 * market-state flag. The `/chart` endpoint exposes everything we
 * need in one round-trip without requiring an API key.
 *
 * Yahoo's quote service is famously inconsistent on bot detection
 * — we send a generic browser-ish User-Agent because that's what
 * gets through reliably. If it ever rate-limits/blocks, the
 * upstream-429 path returns 503 like the rest of the codebase.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

interface ChartMeta {
  symbol?: string;
  currency?: string;
  exchangeName?: string;
  regularMarketPrice?: number | null;
  previousClose?: number | null;
  chartPreviousClose?: number | null;
  regularMarketDayHigh?: number | null;
  regularMarketDayLow?: number | null;
  regularMarketVolume?: number | null;
  fiftyTwoWeekHigh?: number | null;
  fiftyTwoWeekLow?: number | null;
  marketState?: string;
  regularMarketTime?: number;
  preMarketPrice?: number | null;
  preMarketChange?: number | null;
  postMarketPrice?: number | null;
  postMarketChange?: number | null;
}

interface ChartResponse {
  chart?: {
    result?: Array<{ meta?: ChartMeta }>;
    error?: { code?: string; description?: string } | null;
  };
}

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 10_000;

export const yahooStockQuote: InternalHandler = async (
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
    return { status: 400, body: { error: "symbol_required" } };
  }
  const symbol = (parsed as Record<string, unknown>)["symbol"];
  if (typeof symbol !== "string" || symbol.length === 0) {
    return { status: 400, body: { error: "symbol_required" } };
  }
  // Yahoo tickers are 1-12 chars, allow letters + digits + `.` (BRK.B)
  // + `-` (UN-mapped foreign listings).
  if (!/^[A-Za-z0-9.\-]{1,12}$/.test(symbol)) {
    return { status: 400, body: { error: "invalid_symbol_format" } };
  }
  const upper = symbol.toUpperCase();

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(upper)}`;
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
  if (response.status === 404) {
    return { status: 404, body: { error: "symbol_not_found", symbol: upper } };
  }
  if (!response.ok) {
    return { status: 502, body: { error: "upstream_error", upstreamStatus: response.status } };
  }

  let data: ChartResponse;
  try {
    data = (await response.json()) as ChartResponse;
  } catch {
    return { status: 502, body: { error: "upstream_invalid_json" } };
  }
  if (data.chart?.error) {
    return { status: 404, body: { error: "symbol_not_found", symbol: upper } };
  }
  const meta = data.chart?.result?.[0]?.meta;
  if (!meta) {
    return { status: 502, body: { error: "upstream_unexpected_shape" } };
  }

  const price = meta.regularMarketPrice ?? null;
  const prev = meta.previousClose ?? meta.chartPreviousClose ?? null;
  const changePct =
    price !== null && prev !== null && prev !== 0
      ? ((price - prev) / prev) * 100
      : null;

  return {
    status: 200,
    body: {
      symbol: meta.symbol ?? upper,
      exchange: meta.exchangeName ?? null,
      currency: meta.currency ?? null,
      price,
      previous_close: prev,
      change_pct: changePct,
      day_high: meta.regularMarketDayHigh ?? null,
      day_low: meta.regularMarketDayLow ?? null,
      volume: meta.regularMarketVolume ?? null,
      fifty_two_week_high: meta.fiftyTwoWeekHigh ?? null,
      fifty_two_week_low: meta.fiftyTwoWeekLow ?? null,
      market_state: meta.marketState ?? null,
      pre_market_price: meta.preMarketPrice ?? null,
      post_market_price: meta.postMarketPrice ?? null,
      regular_market_time: meta.regularMarketTime ?? null,
    },
  };
};
