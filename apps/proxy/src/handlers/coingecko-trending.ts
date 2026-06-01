/**
 * Trending searches backed by CoinGecko Free API
 * (`/search/trending`). Buyer pays the proxy ($0.005), then we
 * return the top-7 coins CoinGecko surfaces as most-searched in
 * the last 24h. Useful as a cheap retail-attention proxy.
 *
 * Upstream wraps each coin in an `{item: {...}}` envelope; we
 * unwrap so callers see a flat array. We keep the small fields a
 * downstream agent will plausibly use (id, symbol, name, rank,
 * thumb, price_btc) and drop the noisy ones (data.sparkline,
 * data.price_change_percentage_24h.btc, etc.) — anything dropped
 * can come back later if a buyer asks; defaulting to small wins.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

interface CoinGeckoTrendingItem {
  id?: string;
  coin_id?: number;
  name?: string;
  symbol?: string;
  market_cap_rank?: number | null;
  thumb?: string;
  small?: string;
  large?: string;
  slug?: string;
  price_btc?: number;
  score?: number;
}

interface CoinGeckoTrendingEntry {
  item?: CoinGeckoTrendingItem;
}

interface CoinGeckoTrendingResponse {
  coins?: CoinGeckoTrendingEntry[];
}

export const coingeckoTrending: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  // Body is documented as `{}`. We still try-parse if non-empty so
  // a stray content-type sniff doesn't kill an otherwise valid call.
  if (input.body && input.body.length > 0) {
    try {
      JSON.parse(input.body.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "invalid_json_body" } };
    }
  }

  const url = "https://api.coingecko.com/api/v3/search/trending";
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

  let data: CoinGeckoTrendingResponse;
  try {
    data = (await response.json()) as CoinGeckoTrendingResponse;
  } catch {
    return { status: 502, body: { error: "coingecko_invalid_json" } };
  }

  const coins = (data.coins ?? [])
    .filter((entry) => entry?.item)
    .map((entry) => {
      const it = entry.item as CoinGeckoTrendingItem;
      return {
        id: it.id ?? null,
        symbol: it.symbol ?? null,
        name: it.name ?? null,
        market_cap_rank: it.market_cap_rank ?? null,
        thumb: it.thumb ?? null,
        price_btc: it.price_btc ?? null,
        score: it.score ?? null,
      };
    });

  return {
    status: 200,
    body: {
      count: coins.length,
      coins,
    },
  };
};
