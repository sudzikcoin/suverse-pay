/**
 * Multi-symbol funding-rate batch backed by Binance Futures
 * (`fapi /v1/premiumIndex`). Buyer pays the proxy ($0.01), then
 * we pull the FULL perpetual universe (one call, no per-symbol
 * fan-out) and filter to the symbols the caller requested.
 *
 * Pulling all symbols and filtering client-side is cheaper than
 * making N parallel requests when the user wants a watchlist:
 * one upstream credit covers any size up to the per-call limit
 * we enforce (50). Single-symbol callers should hit the dedicated
 * /suverse-perp-funding endpoint instead — it's $0 difference in
 * cost from our side but cleaner from theirs.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

interface PremiumIndexRow {
  symbol?: string;
  markPrice?: string;
  indexPrice?: string;
  estimatedSettlePrice?: string;
  lastFundingRate?: string;
  nextFundingTime?: number;
  interestRate?: string;
  time?: number;
}

const MAX_SYMBOLS = 50;
const TIMEOUT_MS = 10_000;

function num(s: string | undefined): number | null {
  if (typeof s !== "string" || s.length === 0) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export const binanceFundingBatch: InternalHandler = async (
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
  if (!symbols.every((s) => typeof s === "string" && /^[A-Z0-9]{2,20}$/.test(s))) {
    return { status: 400, body: { error: "invalid_symbol_in_list" } };
  }
  const requested = new Set(symbols as string[]);

  const url = "https://fapi.binance.com/fapi/v1/premiumIndex";
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

  const filtered = (raw as PremiumIndexRow[])
    .filter((r) => typeof r.symbol === "string" && requested.has(r.symbol))
    .map((r) => ({
      symbol: r.symbol ?? null,
      mark_price: num(r.markPrice),
      index_price: num(r.indexPrice),
      funding_rate: num(r.lastFundingRate),
      funding_rate_pct:
        num(r.lastFundingRate) !== null
          ? (num(r.lastFundingRate) as number) * 100
          : null,
      next_funding_time: r.nextFundingTime ?? null,
      time: r.time ?? null,
    }));

  // Caller asked for symbols that don't exist on Binance perps:
  // report them in `missing` rather than silently dropping.
  const returnedSyms = new Set(filtered.map((r) => r.symbol).filter(Boolean));
  const missing = (symbols as string[]).filter((s) => !returnedSyms.has(s));

  return {
    status: 200,
    body: {
      requested: symbols.length,
      returned: filtered.length,
      missing,
      rates: filtered,
    },
  };
};
