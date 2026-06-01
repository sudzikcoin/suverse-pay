/**
 * Wilder RSI handler. Buyer pays the proxy ($0.01), then we
 * pull klines from Binance public for the requested symbol +
 * interval, compute the standard Wilder-smoothed RSI in JS, and
 * return the latest value plus the last 50 historical points.
 *
 * We fetch `period + 50 + 1` candles so the 50-point output
 * window doesn't depend on RSI's warmup truncation. Binance
 * accepts intervals 1m,3m,5m,15m,30m,1h,2h,4h,6h,8h,12h,1d,3d,
 * 1w,1M — we validate against that allowlist to fail-fast on a
 * typo before burning the upstream credit.
 */
import { rsi } from "./_ta-math.js";
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

const HISTORY_WINDOW = 50;
const TIMEOUT_MS = 10_000;

export const taRsi: InternalHandler = async (
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
  const interval = (obj["interval"] ?? "1h") as unknown;
  if (typeof interval !== "string" || !ALLOWED_INTERVALS.has(interval)) {
    return { status: 400, body: { error: "invalid_interval" } };
  }
  let period = 14;
  if (obj["period"] !== undefined) {
    const raw = obj["period"];
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 2 || raw > 200) {
      return { status: 400, body: { error: "invalid_period" } };
    }
    period = raw;
  }

  const limit = period + HISTORY_WINDOW + 1;
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;

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
  if (!Array.isArray(raw) || raw.length < period + 2) {
    return { status: 502, body: { error: "insufficient_klines" } };
  }
  // Binance kline row: [openTime, open, high, low, close, ...]
  const closes: number[] = [];
  const closeTimes: number[] = [];
  for (const row of raw as unknown[][]) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const close = Number.parseFloat(String(row[4]));
    if (Number.isFinite(close)) {
      closes.push(close);
      closeTimes.push(Number(row[6]) || 0);
    }
  }
  if (closes.length < period + 2) {
    return { status: 502, body: { error: "insufficient_klines" } };
  }

  const { rsi: rsiValues, startIndex } = rsi(closes, period);
  if (rsiValues.length === 0) {
    return { status: 502, body: { error: "rsi_computation_failed" } };
  }
  const tail = rsiValues.slice(-HISTORY_WINDOW);
  const tailStartInValues = closes.length - tail.length;
  const historical = tail.map((value, i) => ({
    time: closeTimes[tailStartInValues + i] ?? null,
    value,
  }));
  const current = tail[tail.length - 1]!;

  let signal: "overbought" | "oversold" | "neutral" = "neutral";
  if (current >= 70) signal = "overbought";
  else if (current <= 30) signal = "oversold";

  // Trend: compare current to the average of last 5.
  const recent = tail.slice(-5);
  const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
  const trend =
    current > recentAvg + 1
      ? "rising"
      : current < recentAvg - 1
        ? "falling"
        : "flat";

  return {
    status: 200,
    body: {
      symbol,
      interval,
      period,
      start_index: startIndex,
      current_rsi: current,
      signal,
      trend,
      historical,
    },
  };
};
