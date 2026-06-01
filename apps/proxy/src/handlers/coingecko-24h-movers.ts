/**
 * Top 10 gainers + top 10 losers in last 24h backed by CoinGecko
 * Free API. Buyer pays the proxy ($0.01), then we fetch the top
 * 250 coins by market cap, filter by a minimum market-cap floor
 * to weed out pump-and-dump micro-caps, and bucket into gainers
 * + losers by 24h percentage change.
 *
 * Fetching the top 250 is a single CoinGecko call; trying to do
 * "all 17k coins" in one go is impossible (paged) and would burn
 * 20+ Free-tier credits per buyer call. Top-250 + market-cap
 * floor is the closest cheap approximation that still gets the
 * meaningful movers an AI trading agent actually cares about.
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
}

const DEFAULT_MIN_MCAP = 10_000_000;
const TOP_N = 10;

export const coingecko24hMovers: InternalHandler = async (
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

  let minMcap = DEFAULT_MIN_MCAP;
  if (parsed !== null && typeof parsed === "object") {
    const raw = (parsed as Record<string, unknown>)["min_market_cap"];
    if (raw !== undefined) {
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
        return { status: 400, body: { error: "invalid_min_market_cap" } };
      }
      minMcap = raw;
    }
  }

  const params = new URLSearchParams();
  params.set("vs_currency", "usd");
  params.set("order", "market_cap_desc");
  params.set("per_page", "250");
  params.set("page", "1");
  params.set("price_change_percentage", "24h");
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

  const filtered = (data as CoinGeckoMarket[])
    .filter(
      (c) =>
        typeof c.market_cap === "number" &&
        c.market_cap >= minMcap &&
        typeof c.price_change_percentage_24h === "number",
    )
    .map((c) => ({
      id: c.id ?? null,
      symbol: c.symbol ?? null,
      name: c.name ?? null,
      current_price: c.current_price ?? null,
      market_cap: c.market_cap ?? null,
      total_volume: c.total_volume ?? null,
      price_change_percentage_24h: c.price_change_percentage_24h ?? null,
    }));

  const gainers = [...filtered]
    .sort(
      (a, b) =>
        (b.price_change_percentage_24h ?? 0) -
        (a.price_change_percentage_24h ?? 0),
    )
    .slice(0, TOP_N);
  const losers = [...filtered]
    .sort(
      (a, b) =>
        (a.price_change_percentage_24h ?? 0) -
        (b.price_change_percentage_24h ?? 0),
    )
    .slice(0, TOP_N);

  return {
    status: 200,
    body: {
      min_market_cap: minMcap,
      pool_size: filtered.length,
      gainers,
      losers,
    },
  };
};
