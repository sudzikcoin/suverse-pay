/**
 * Moving-average dashboard: SMA + EMA at 20/50/200 with
 * golden-cross / death-cross detection on SMA50 vs SMA200 within
 * the last 10 periods.
 *
 * Buyer pays the proxy ($0.01). We pull 250 klines (enough to
 * seed the 200-period MAs with 50 free bars) and return the
 * current price, all six averages, the cross result, and a
 * simple trend tag based on whether price > SMA200.
 *
 * 250 is also our hardcoded `limit` to Binance — the upstream's
 * cap is 1000 but more bars buys no extra accuracy for the
 * indicators we care about here.
 */
import { detectCross, ema, sma } from "./_ta-math.js";
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

const ALLOWED_INTERVALS = new Set([
  "1m","3m","5m","15m","30m",
  "1h","2h","4h","6h","8h","12h",
  "1d","3d","1w","1M",
]);

const KLINE_LIMIT = 250;
const TIMEOUT_MS = 10_000;
const CROSS_LOOKBACK = 10;

export const taMovingAverages: InternalHandler = async (
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
  const obj = parsed as Record<string, unknown>;
  const symbol = obj["symbol"];
  if (typeof symbol !== "string" || !/^[A-Z0-9]{2,20}$/.test(symbol)) {
    return { status: 400, body: { error: "invalid_symbol" } };
  }
  const interval = (obj["interval"] ?? "1d") as unknown;
  if (typeof interval !== "string" || !ALLOWED_INTERVALS.has(interval)) {
    return { status: 400, body: { error: "invalid_interval" } };
  }

  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${KLINE_LIMIT}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { accept: "application/json" },
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
  if (response.status === 400) {
    return { status: 404, body: { error: "symbol_not_found", symbol } };
  }
  if (!response.ok) {
    return { status: 502, body: { error: "upstream_error", upstreamStatus: response.status } };
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return { status: 502, body: { error: "upstream_invalid_json" } };
  }
  if (!Array.isArray(raw)) {
    return { status: 502, body: { error: "upstream_unexpected_shape" } };
  }
  const closes: number[] = [];
  for (const row of raw as unknown[][]) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const close = Number.parseFloat(String(row[4]));
    if (Number.isFinite(close)) closes.push(close);
  }
  if (closes.length < 201) {
    return {
      status: 502,
      body: { error: "insufficient_klines", required: 201, got: closes.length },
    };
  }

  const currentPrice = closes[closes.length - 1]!;
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);

  // Golden / death cross on SMA50 vs SMA200, aligned to SMA200's index window.
  const sma50Aligned = sma50.slice(sma50.length - sma200.length);
  const crossRaw = detectCross(sma50Aligned, sma200, CROSS_LOOKBACK);
  const cross = crossRaw
    ? {
        // Re-label in classic technical-analysis vocab.
        type: crossRaw.direction === "bullish" ? "golden_cross" : "death_cross",
        periods_ago: crossRaw.periodsAgo,
      }
    : null;

  const trend =
    currentPrice > sma200[sma200.length - 1]!
      ? "above_200sma"
      : "below_200sma";

  return {
    status: 200,
    body: {
      symbol,
      interval,
      current_price: currentPrice,
      sma_20: sma20[sma20.length - 1]!,
      sma_50: sma50[sma50.length - 1]!,
      sma_200: sma200[sma200.length - 1]!,
      ema_20: ema20[ema20.length - 1]!,
      ema_50: ema50[ema50.length - 1]!,
      ema_200: ema200[ema200.length - 1]!,
      cross,
      trend,
    },
  };
};
