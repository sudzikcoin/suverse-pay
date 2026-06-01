/**
 * Spot order-book snapshot backed by Binance public
 * (`/api/v3/depth`). Buyer pays the proxy ($0.005), then we
 * return the top N bids + asks for a spot pair plus a few
 * derived microstructure stats (total depth, imbalance ratio)
 * that an MEV/arb agent would compute anyway — cheaper to send
 * pre-aggregated than to round-trip a calculator.
 *
 * Binance's depth endpoint allows limit ∈ {5, 10, 20, 50, 100,
 * 500, 1000, 5000}; we cap at 100 (the default-quoted ceiling)
 * to keep latency snappy and credits cheap.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

interface DepthResponse {
  lastUpdateId?: number;
  bids?: [string, string][];
  asks?: [string, string][];
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const TIMEOUT_MS = 10_000;
const ALLOWED_LIMITS = [5, 10, 20, 50, 100];

function pickAllowed(n: number): number {
  // Snap to the next allowed step Binance supports.
  for (const a of ALLOWED_LIMITS) {
    if (a >= n) return a;
  }
  return MAX_LIMIT;
}

export const binanceOrderbook: InternalHandler = async (
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
  const rawSymbol = obj["symbol"];
  if (typeof rawSymbol !== "string" || rawSymbol.length === 0) {
    return { status: 400, body: { error: "symbol_required" } };
  }
  if (!/^[A-Z0-9]{2,20}$/.test(rawSymbol)) {
    return { status: 400, body: { error: "invalid_symbol_format" } };
  }

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
  const upstreamLimit = pickAllowed(limit);

  const url = `https://api.binance.com/api/v3/depth?symbol=${encodeURIComponent(rawSymbol)}&limit=${upstreamLimit}`;
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
    return { status: 404, body: { error: "symbol_not_found", symbol: rawSymbol } };
  }
  if (!response.ok) {
    return { status: 502, body: { error: "upstream_error", upstreamStatus: response.status } };
  }

  let data: DepthResponse;
  try {
    data = (await response.json()) as DepthResponse;
  } catch {
    return { status: 502, body: { error: "upstream_invalid_json" } };
  }

  const bids = Array.isArray(data.bids) ? data.bids.slice(0, limit) : [];
  const asks = Array.isArray(data.asks) ? data.asks.slice(0, limit) : [];

  const bidDepth = bids.reduce(
    (sum, [, qty]) => sum + Number.parseFloat(qty),
    0,
  );
  const askDepth = asks.reduce(
    (sum, [, qty]) => sum + Number.parseFloat(qty),
    0,
  );
  const imbalance =
    bidDepth + askDepth > 0
      ? (bidDepth - askDepth) / (bidDepth + askDepth)
      : null;

  return {
    status: 200,
    body: {
      symbol: rawSymbol,
      last_update_id: data.lastUpdateId ?? null,
      bids,
      asks,
      bid_depth: bidDepth,
      ask_depth: askDepth,
      imbalance_ratio: imbalance,
    },
  };
};
