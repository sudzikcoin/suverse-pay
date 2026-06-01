/**
 * Protocol TVL history backed by DeFiLlama (`/protocol/{slug}`).
 * Buyer pays the proxy ($0.02), then we return up to the last 90
 * daily TVL points for the protocol plus the chain-broken-out TVL
 * breakdown.
 *
 * DeFiLlama returns the FULL history (years of points for older
 * protocols). We slice to the last 90 to keep the response under
 * a sane budget — agents that need deeper history can paginate at
 * a future endpoint, but 99% of "show me the chart" use cases
 * stop at 90 days.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

interface TvlPoint {
  date?: number;
  totalLiquidityUSD?: number;
}

interface ProtocolResponse {
  name?: string;
  symbol?: string;
  chain?: string;
  category?: string;
  tvl?: TvlPoint[] | number;
  chainTvls?: Record<string, { tvl?: TvlPoint[] } | unknown>;
  currentChainTvls?: Record<string, number>;
}

const HISTORY_WINDOW = 90;
const TIMEOUT_MS = 10_000;

export const defillamaProtocolTvl: InternalHandler = async (
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
    return { status: 400, body: { error: "protocol_required" } };
  }
  const slug = (parsed as Record<string, unknown>)["protocol"];
  if (typeof slug !== "string" || slug.length === 0) {
    return { status: 400, body: { error: "protocol_required" } };
  }
  // DeFiLlama slugs are lowercase kebab-case (aave-v3, uniswap-v3).
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) {
    return { status: 400, body: { error: "invalid_protocol_format" } };
  }

  const url = `https://api.llama.fi/protocol/${encodeURIComponent(slug)}`;
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
  if (response.status === 404) {
    return { status: 404, body: { error: "protocol_not_found", protocol: slug } };
  }
  if (!response.ok) {
    return { status: 502, body: { error: "upstream_error", upstreamStatus: response.status } };
  }

  let data: ProtocolResponse;
  try {
    data = (await response.json()) as ProtocolResponse;
  } catch {
    return { status: 502, body: { error: "upstream_invalid_json" } };
  }

  const tvlSeries = Array.isArray(data.tvl) ? (data.tvl as TvlPoint[]) : [];
  const recent = tvlSeries.slice(-HISTORY_WINDOW).map((p) => ({
    date: p.date ?? null,
    tvl_usd: p.totalLiquidityUSD ?? null,
  }));

  return {
    status: 200,
    body: {
      protocol: slug,
      name: data.name ?? null,
      symbol: data.symbol ?? null,
      category: data.category ?? null,
      home_chain: data.chain ?? null,
      tvl_series_days: recent.length,
      tvl_series: recent,
      current_chain_tvls: data.currentChainTvls ?? {},
    },
  };
};
