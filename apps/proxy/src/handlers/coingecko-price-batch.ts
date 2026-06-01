/**
 * Batch price lookup backed by CoinGecko Free API (`/coins/markets`).
 *
 * Buyer pays the proxy ($0.005), then we ask CoinGecko for current
 * USD prices + 24h-change + market cap + volume for up to 50 coin
 * IDs in one shot. Returns a normalized array — strips CoinGecko's
 * 25+ fields down to the eight a portfolio agent typically wants,
 * so the caller's parser doesn't have to grow with every CoinGecko
 * schema addition.
 *
 * CoinGecko Free is ~30 req/min unauthenticated; if upstream
 * 429s the handler maps to 503 `rate_limit_upstream` so callers see
 * a retryable signal rather than a confusing 4xx.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

interface CoinGeckoMarket {
  id?: string;
  symbol?: string;
  name?: string;
  current_price?: number | null;
  market_cap?: number | null;
  total_volume?: number | null;
  price_change_percentage_24h?: number | null;
  last_updated?: string;
}

export const coingeckoPriceBatch: InternalHandler = async (
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
    return { status: 400, body: { error: "ids_required" } };
  }
  const obj = parsed as Record<string, unknown>;
  const ids = obj["ids"];
  if (!Array.isArray(ids) || ids.length === 0) {
    return { status: 400, body: { error: "ids_required" } };
  }
  if (ids.length > 50) {
    return { status: 400, body: { error: "too_many_ids", max: 50 } };
  }
  if (!ids.every((v) => typeof v === "string" && v.length > 0)) {
    return { status: 400, body: { error: "ids_must_be_non_empty_strings" } };
  }

  const rawCurrency = obj["vs_currency"];
  const vsCurrency =
    typeof rawCurrency === "string" && rawCurrency.length > 0
      ? rawCurrency.toLowerCase()
      : "usd";

  const params = new URLSearchParams();
  params.set("vs_currency", vsCurrency);
  params.set("ids", ids.join(","));
  params.set("order", "market_cap_desc");
  params.set("per_page", "50");
  params.set("page", "1");
  const url = `https://api.coingecko.com/api/v3/coins/markets?${params.toString()}`;

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

  const coins = (data as CoinGeckoMarket[]).map((c) => ({
    id: c.id ?? null,
    symbol: c.symbol ?? null,
    name: c.name ?? null,
    current_price: c.current_price ?? null,
    market_cap: c.market_cap ?? null,
    total_volume: c.total_volume ?? null,
    price_change_percentage_24h: c.price_change_percentage_24h ?? null,
    last_updated: c.last_updated ?? null,
  }));

  return {
    status: 200,
    body: {
      vs_currency: vsCurrency,
      requested: ids.length,
      returned: coins.length,
      coins,
    },
  };
};
