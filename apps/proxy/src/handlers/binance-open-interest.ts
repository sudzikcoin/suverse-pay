/**
 * Open-interest snapshot + 24h history backed by Binance Futures
 * (`/futures/data/openInterestHist`). Buyer pays the proxy
 * ($0.01), then we return the latest OI snapshot plus a 5-minute
 * resolution series over the last 24h (288 points).
 *
 * Binance returns oldest-first; we keep that ordering for chart
 * libraries that expect ascending time. The 24h change percentage
 * is derived from first vs last point — cheap, deterministic, and
 * agents that want a different window can compute their own from
 * the raw history.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

interface OiPoint {
  symbol?: string;
  sumOpenInterest?: string;
  sumOpenInterestValue?: string;
  timestamp?: number;
}

const TIMEOUT_MS = 10_000;

export const binanceOpenInterest: InternalHandler = async (
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
  if (typeof symbol !== "string" || !/^[A-Z0-9]{2,20}$/.test(symbol)) {
    return { status: 400, body: { error: "invalid_symbol" } };
  }

  const url = `https://fapi.binance.com/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=5m&limit=288`;
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
  if (!Array.isArray(raw) || raw.length === 0) {
    return { status: 502, body: { error: "no_data" } };
  }

  const series = (raw as OiPoint[])
    .filter((p) => p && typeof p.sumOpenInterest === "string")
    .map((p) => ({
      timestamp: p.timestamp ?? null,
      open_interest: Number.parseFloat(p.sumOpenInterest ?? "0"),
      open_interest_usd: Number.parseFloat(p.sumOpenInterestValue ?? "0"),
    }));

  if (series.length === 0) {
    return { status: 502, body: { error: "no_data" } };
  }

  const first = series[0]!;
  const last = series[series.length - 1]!;
  const change24hPct =
    first.open_interest !== 0
      ? ((last.open_interest - first.open_interest) / first.open_interest) * 100
      : null;

  return {
    status: 200,
    body: {
      symbol,
      current_open_interest: last.open_interest,
      current_open_interest_usd: last.open_interest_usd,
      change_24h_pct: change24hPct,
      points: series.length,
      history: series,
    },
  };
};
