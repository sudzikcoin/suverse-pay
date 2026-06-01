/**
 * Top-N market-cap rankings backed by CoinGecko Free API
 * (`/coins/markets` with extra `price_change_percentage` columns).
 *
 * Buyer pays the proxy ($0.01), then we return up to 250 coins
 * ranked by market cap with the full screening dataset: price,
 * volume, percentage changes across 1h/24h/7d/30d, fully diluted
 * valuation, supply numbers, all-time-high/low data.
 *
 * Limit is capped at CoinGecko's documented `per_page` ceiling of
 * 250. Pagination is via the `page` field — caller asks for page 2
 * to get ranks 251–500 etc.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

export const coingeckoMarketRankings: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  let parsed: unknown = null;
  if (input.body && input.body.length > 0) {
    try {
      parsed = JSON.parse(input.body.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "invalid_json_body" } };
    }
  }

  let limit = 50;
  let page = 1;
  if (parsed !== null && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const rawLimit = obj["limit"];
    if (rawLimit !== undefined) {
      if (
        typeof rawLimit !== "number" ||
        !Number.isInteger(rawLimit) ||
        rawLimit < 1
      ) {
        return { status: 400, body: { error: "invalid_limit" } };
      }
      limit = Math.min(rawLimit, 250);
    }
    const rawPage = obj["page"];
    if (rawPage !== undefined) {
      if (
        typeof rawPage !== "number" ||
        !Number.isInteger(rawPage) ||
        rawPage < 1
      ) {
        return { status: 400, body: { error: "invalid_page" } };
      }
      page = rawPage;
    }
  }

  const params = new URLSearchParams();
  params.set("vs_currency", "usd");
  params.set("order", "market_cap_desc");
  params.set("per_page", String(limit));
  params.set("page", String(page));
  params.set("price_change_percentage", "1h,24h,7d,30d");
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

  return {
    status: 200,
    body: {
      page,
      limit,
      count: data.length,
      coins: data,
    },
  };
};
