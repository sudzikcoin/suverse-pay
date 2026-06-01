/**
 * Historical forex rate backed by Frankfurter
 * (`api.frankfurter.app/{date}`). Buyer pays the proxy ($0.01),
 * then we return the ECB reference rate for a single pair on a
 * single date. Frankfurter coverage starts 1999-01-04 (ECB's own
 * coverage window for euro-area rates).
 *
 * Weekends and holidays don't have ECB fixings — the API
 * automatically returns the most recent prior trading day in
 * those cases. We surface the `date` field from the response so
 * the caller can spot when this rollback happened.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

interface FrankfurterHistoricalResponse {
  amount?: number;
  base?: string;
  date?: string;
  rates?: Record<string, number>;
}

const TIMEOUT_MS = 10_000;
const MIN_DATE = "1999-01-04";

export const frankfurterHistorical: InternalHandler = async (
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
    return { status: 400, body: { error: "date_required" } };
  }
  const obj = parsed as Record<string, unknown>;
  const date = obj["date"];
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { status: 400, body: { error: "invalid_date_format" } };
  }
  if (date < MIN_DATE) {
    return { status: 400, body: { error: "date_before_coverage", min: MIN_DATE } };
  }
  const today = new Date().toISOString().slice(0, 10);
  if (date > today) {
    return { status: 400, body: { error: "date_in_future" } };
  }
  const rawBase = obj["base"];
  const base =
    typeof rawBase === "string" && rawBase.length === 3
      ? rawBase.toUpperCase()
      : "USD";
  if (!/^[A-Z]{3}$/.test(base)) {
    return { status: 400, body: { error: "invalid_base" } };
  }
  const symbol = obj["symbol"];
  if (typeof symbol !== "string" || !/^[A-Z]{3}$/i.test(symbol)) {
    return { status: 400, body: { error: "invalid_symbol" } };
  }
  const upperSym = symbol.toUpperCase();

  const url = `https://api.frankfurter.app/${date}?from=${encodeURIComponent(base)}&to=${encodeURIComponent(upperSym)}`;
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
    return { status: 400, body: { error: "unsupported_currency_or_date" } };
  }
  if (!response.ok) {
    return { status: 502, body: { error: "upstream_error", upstreamStatus: response.status } };
  }

  let data: FrankfurterHistoricalResponse;
  try {
    data = (await response.json()) as FrankfurterHistoricalResponse;
  } catch {
    return { status: 502, body: { error: "upstream_invalid_json" } };
  }
  const rate = data.rates?.[upperSym];
  if (typeof rate !== "number" || !Number.isFinite(rate)) {
    return {
      status: 502,
      body: { error: "rate_not_in_response", expected: upperSym },
    };
  }
  return {
    status: 200,
    body: {
      requested_date: date,
      effective_date: data.date ?? null,
      base: data.base ?? base,
      symbol: upperSym,
      rate,
      // ECB rate rollback: when the requested date was a weekend/holiday,
      // upstream `data.date` is the prior trading day. Surface so callers
      // can detect.
      rolled_back: data.date !== undefined && data.date !== date,
    },
  };
};
