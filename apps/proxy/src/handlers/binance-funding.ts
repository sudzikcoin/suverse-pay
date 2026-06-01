/**
 * Perpetual funding rate + premium index backed by Binance
 * Futures (`fapi /v1/premiumIndex`). Buyer pays the proxy
 * ($0.01), then we return the current funding rate, the next
 * funding timestamp, and the gap between mark and index price.
 *
 * Binance returns the funding number as a string in scientific
 * notation; we cast to number on the way out so JS-side agents
 * don't have to parseFloat. The `funding_rate_pct` field is the
 * raw funding * 100 — same convention every perp dashboard uses.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

interface PremiumIndex {
  symbol?: string;
  markPrice?: string;
  indexPrice?: string;
  estimatedSettlePrice?: string;
  lastFundingRate?: string;
  nextFundingTime?: number;
  interestRate?: string;
  time?: number;
}

const TIMEOUT_MS = 10_000;

function toNumber(s: string | undefined | null): number | null {
  if (typeof s !== "string" || s.length === 0) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export const binanceFunding: InternalHandler = async (
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
  const rawSymbol = (parsed as Record<string, unknown>)["symbol"];
  if (typeof rawSymbol !== "string" || rawSymbol.length === 0) {
    return { status: 400, body: { error: "symbol_required" } };
  }
  if (!/^[A-Z0-9]{2,20}$/.test(rawSymbol)) {
    return { status: 400, body: { error: "invalid_symbol_format" } };
  }

  const url = `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${encodeURIComponent(rawSymbol)}`;
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

  let data: PremiumIndex;
  try {
    data = (await response.json()) as PremiumIndex;
  } catch {
    return { status: 502, body: { error: "upstream_invalid_json" } };
  }

  const mark = toNumber(data.markPrice);
  const index = toNumber(data.indexPrice);
  const funding = toNumber(data.lastFundingRate);

  return {
    status: 200,
    body: {
      symbol: data.symbol ?? rawSymbol,
      mark_price: mark,
      index_price: index,
      mark_index_spread:
        mark !== null && index !== null ? mark - index : null,
      funding_rate: funding,
      funding_rate_pct: funding !== null ? funding * 100 : null,
      next_funding_time: data.nextFundingTime ?? null,
      estimated_settle_price: toNumber(data.estimatedSettlePrice),
      interest_rate: toNumber(data.interestRate),
      time: data.time ?? null,
    },
  };
};
