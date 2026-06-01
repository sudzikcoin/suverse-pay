/**
 * MACD(12,26,9) handler. Buyer pays the proxy ($0.01), then we
 * pull klines from Binance public, compute MACD line + signal +
 * histogram locally, and report the most recent values plus
 * crossover detection within the last 5 bars.
 *
 * The crossover window of 5 bars is the operationally useful
 * range for an automated trader — older crosses are stale signal
 * by the time an agent acts on them. A buyer that wants a longer
 * lookback can re-call with a different timeframe.
 */
import { detectCross, macd } from "./_ta-math.js";
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

const FAST = 12;
const SLOW = 26;
const SIGNAL = 9;
const LOOKBACK = 5;
// Need slow + signal + lookback + headroom — Binance kline max is
// 1000 anyway, and a 100-bar window is plenty for stable EMA seeds.
const KLINE_LIMIT = 200;
const TIMEOUT_MS = 10_000;

export const taMacd: InternalHandler = async (
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
  if (closes.length < SLOW + SIGNAL + 2) {
    return { status: 502, body: { error: "insufficient_klines" } };
  }

  const { macd: macdLine, signal: signalLine, histogram } = macd(
    closes,
    FAST,
    SLOW,
    SIGNAL,
  );
  const currentMacd = macdLine[macdLine.length - 1]!;
  const currentSignal = signalLine[signalLine.length - 1]!;
  const currentHistogram = histogram[histogram.length - 1]!;
  // Crossover detection is between MACD line + signal line over
  // the bars where both exist (signal series is shorter).
  const macdAligned = macdLine.slice(macdLine.length - signalLine.length);
  const cross = detectCross(macdAligned, signalLine, LOOKBACK);

  const trend =
    currentHistogram > 0 && histogram[histogram.length - 2]! > 0
      ? "uptrend"
      : currentHistogram < 0 && histogram[histogram.length - 2]! < 0
        ? "downtrend"
        : "transitioning";

  return {
    status: 200,
    body: {
      symbol,
      interval,
      fast: FAST,
      slow: SLOW,
      signal_period: SIGNAL,
      current_macd: currentMacd,
      current_signal: currentSignal,
      current_histogram: currentHistogram,
      cross,
      trend,
      histogram_last_10: histogram.slice(-10),
    },
  };
};
