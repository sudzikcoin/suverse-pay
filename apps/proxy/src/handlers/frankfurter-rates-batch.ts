/**
 * Batch forex rates backed by Frankfurter (`api.frankfurter.app
 * /latest`). Buyer pays the proxy ($0.005), then we return ECB
 * reference rates for up to 30 currency pairs against a chosen
 * base currency in one upstream call.
 *
 * Frankfurter is an ECB-backed free API — no auth, no rate limit
 * worth worrying about, daily-updated reference rates for ~30
 * fiat currencies. We cap at 30 symbols per call to match the
 * comfortable max of currencies they list.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

const MAX_SYMBOLS = 30;
const TIMEOUT_MS = 10_000;

interface FrankfurterLatest {
  amount?: number;
  base?: string;
  date?: string;
  rates?: Record<string, number>;
}

export const frankfurterRatesBatch: InternalHandler = async (
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
  const rawBase = obj["base"];
  const base =
    typeof rawBase === "string" && rawBase.length === 3
      ? rawBase.toUpperCase()
      : "USD";
  if (!/^[A-Z]{3}$/.test(base)) {
    return { status: 400, body: { error: "invalid_base" } };
  }
  const symbols = obj["symbols"];
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return { status: 400, body: { error: "symbols_required" } };
  }
  if (symbols.length > MAX_SYMBOLS) {
    return { status: 400, body: { error: "too_many_symbols", max: MAX_SYMBOLS } };
  }
  if (!symbols.every((s) => typeof s === "string" && /^[A-Z]{3}$/i.test(s))) {
    return { status: 400, body: { error: "invalid_symbol_in_list" } };
  }
  const upper = (symbols as string[]).map((s) => s.toUpperCase());

  const url = `https://api.frankfurter.app/latest?from=${encodeURIComponent(base)}&to=${encodeURIComponent(upper.join(","))}`;
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
  if (response.status === 404 || response.status === 422) {
    return { status: 400, body: { error: "unsupported_currency" } };
  }
  if (!response.ok) {
    return { status: 502, body: { error: "upstream_error", upstreamStatus: response.status } };
  }

  let data: FrankfurterLatest;
  try {
    data = (await response.json()) as FrankfurterLatest;
  } catch {
    return { status: 502, body: { error: "upstream_invalid_json" } };
  }
  const rates = data.rates ?? {};

  const returnedSyms = new Set(Object.keys(rates));
  const missing = upper.filter((s) => !returnedSyms.has(s));

  return {
    status: 200,
    body: {
      base: data.base ?? base,
      date: data.date ?? null,
      requested: upper.length,
      returned: Object.keys(rates).length,
      missing,
      rates,
    },
  };
};
