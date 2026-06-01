/**
 * Recent trades backed by Binance public (`/api/v3/trades`).
 * Buyer pays the proxy ($0.005), then we return the most recent
 * N executions for a spot pair with price, qty, timestamp, and
 * the buyer/maker side flag.
 *
 * Binance's `isBuyerMaker:true` means the trade was a SELL into
 * a resting bid (taker sold). We flip that to a `side` string
 * (`buy`/`sell`) from the taker's perspective so a tape-reader
 * agent doesn't have to memorize the convention.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

interface BinanceTrade {
  id?: number;
  price?: string;
  qty?: string;
  quoteQty?: string;
  time?: number;
  isBuyerMaker?: boolean;
  isBestMatch?: boolean;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const TIMEOUT_MS = 10_000;

export const binanceTrades: InternalHandler = async (
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

  const url = `https://api.binance.com/api/v3/trades?symbol=${encodeURIComponent(rawSymbol)}&limit=${limit}`;
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

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { status: 502, body: { error: "upstream_invalid_json" } };
  }
  if (!Array.isArray(data)) {
    return { status: 502, body: { error: "upstream_unexpected_shape" } };
  }

  const trades = (data as BinanceTrade[]).map((t) => ({
    id: t.id ?? null,
    price: t.price ?? null,
    qty: t.qty ?? null,
    quote_qty: t.quoteQty ?? null,
    time: t.time ?? null,
    side: t.isBuyerMaker ? "sell" : "buy",
    is_best_match: t.isBestMatch ?? null,
  }));

  return {
    status: 200,
    body: { symbol: rawSymbol, count: trades.length, trades },
  };
};
