/**
 * Daily OHLC history backed by CoinGecko Free API
 * (`/coins/{id}/ohlc`). Buyer pays the proxy ($0.02), then we fetch
 * daily candle bars going back up to 365 days for a single coin.
 *
 * Upstream returns `[ts_ms, open, high, low, close]` rows. We
 * reshape into named-field objects and add an ISO date so the
 * caller doesn't have to convert epochs themselves — keeps the
 * common-case parse on the caller side to a single JSON.parse.
 *
 * CoinGecko's `days` parameter accepts 1, 7, 14, 30, 90, 180, 365.
 * Other values silently round on the upstream side; we cap at 365
 * to match the documented Free-tier ceiling.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

export const coingeckoOhlcHistory: InternalHandler = async (
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
    return { status: 400, body: { error: "coin_id_required" } };
  }
  const obj = parsed as Record<string, unknown>;
  const coinId = obj["coin_id"];
  if (typeof coinId !== "string" || coinId.length === 0) {
    return { status: 400, body: { error: "coin_id_required" } };
  }
  // CoinGecko IDs are lowercase slugs (`bitcoin`, `wrapped-bitcoin`).
  // Reject obvious garbage before burning an upstream call.
  if (!/^[a-z0-9-]{1,80}$/.test(coinId)) {
    return { status: 400, body: { error: "invalid_coin_id_format" } };
  }

  let days = 30;
  const rawDays = obj["days"];
  if (rawDays !== undefined) {
    if (
      typeof rawDays !== "number" ||
      !Number.isInteger(rawDays) ||
      rawDays < 1
    ) {
      return { status: 400, body: { error: "invalid_days" } };
    }
    days = Math.min(rawDays, 365);
  }

  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(
    coinId,
  )}/ohlc?vs_currency=usd&days=${days}`;

  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
  } catch {
    return { status: 502, body: { error: "coingecko_unreachable" } };
  }

  if (response.status === 429) {
    return { status: 503, body: { error: "rate_limit_upstream" } };
  }
  if (response.status === 404) {
    return { status: 404, body: { error: "coin_not_found", coin_id: coinId } };
  }
  if (!response.ok) {
    return {
      status: 502,
      body: { error: "coingecko_api_error", upstreamStatus: response.status },
    };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { status: 502, body: { error: "coingecko_invalid_json" } };
  }

  if (!Array.isArray(data)) {
    return { status: 502, body: { error: "coingecko_unexpected_shape" } };
  }

  const candles = (data as unknown[][])
    .filter((row) => Array.isArray(row) && row.length >= 5)
    .map((row) => {
      const [ts, open, high, low, close] = row as [
        number,
        number,
        number,
        number,
        number,
      ];
      return {
        timestamp: ts,
        date_iso: new Date(ts).toISOString(),
        open,
        high,
        low,
        close,
      };
    });

  return {
    status: 200,
    body: {
      coin_id: coinId,
      days,
      count: candles.length,
      candles,
    },
  };
};
