/**
 * Stablecoin circulating supply + per-chain breakdown backed by
 * DeFiLlama Stablecoins (`stablecoins.llama.fi/stablecoins`).
 *
 * Buyer pays the proxy ($0.01), then we return the top-20 by
 * total circulating supply with a `chainCirculating` map and the
 * latest peg price. Top-20 covers >99% of stablecoin float
 * (USDT/USDC/DAI/FDUSD/PYUSD/Frax dominate the long tail) — going
 * deeper costs the buyer the same but ships kilobytes of noise.
 *
 * Note: at the time of writing, the DeFiLlama Stablecoins API
 * was still on the free tier; if they move it behind a paywall
 * (as they did with `bridges.*`), we'll get HTTP 402 and the
 * standard `upstream_error` 502 path here.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

interface StablePrice {
  current?: number | null;
  prevDay?: number | null;
  prevWeek?: number | null;
  prevMonth?: number | null;
}

interface Stable {
  id?: string;
  name?: string;
  symbol?: string;
  pegType?: string;
  pegMechanism?: string;
  price?: number | null;
  circulating?: { peggedUSD?: number } | null;
  chainCirculating?: Record<string, { current?: { peggedUSD?: number } }>;
  chains?: string[];
  // Some shapes also surface change percentages directly.
  circulatingPrevDay?: { peggedUSD?: number };
  circulatingPrevMonth?: { peggedUSD?: number };
}

interface StableResponse {
  peggedAssets?: Stable[];
}

const TOP_N = 20;
const TIMEOUT_MS = 10_000;

export const defillamaStablecoins: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  if (input.body && input.body.length > 0) {
    try {
      JSON.parse(input.body.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "invalid_json_body" } };
    }
  }

  const url = "https://stablecoins.llama.fi/stablecoins?includePrices=true";
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

  let data: StableResponse;
  try {
    data = (await response.json()) as StableResponse;
  } catch {
    return { status: 502, body: { error: "upstream_invalid_json" } };
  }
  const peggedAssets = Array.isArray(data.peggedAssets) ? data.peggedAssets : [];

  const sorted = [...peggedAssets].sort((a, b) => {
    const av = a.circulating?.peggedUSD ?? 0;
    const bv = b.circulating?.peggedUSD ?? 0;
    return bv - av;
  });

  const top = sorted.slice(0, TOP_N).map((s) => {
    const chainBreakdown: Record<string, number> = {};
    const cc = s.chainCirculating ?? {};
    for (const [chain, val] of Object.entries(cc)) {
      const supply = (val as { current?: { peggedUSD?: number } })?.current?.peggedUSD;
      if (typeof supply === "number") chainBreakdown[chain] = supply;
    }
    const currentSupply = s.circulating?.peggedUSD ?? null;
    const prevDay = s.circulatingPrevDay?.peggedUSD ?? null;
    const prevMonth = s.circulatingPrevMonth?.peggedUSD ?? null;
    return {
      id: s.id ?? null,
      name: s.name ?? null,
      symbol: s.symbol ?? null,
      peg_type: s.pegType ?? null,
      peg_mechanism: s.pegMechanism ?? null,
      price_usd: s.price ?? null,
      circulating_usd: currentSupply,
      change_24h_usd: prevDay !== null && currentSupply !== null ? currentSupply - prevDay : null,
      change_30d_usd: prevMonth !== null && currentSupply !== null ? currentSupply - prevMonth : null,
      chain_circulating: chainBreakdown,
    };
  });

  const totalSupply = top.reduce(
    (sum, s) => sum + (s.circulating_usd ?? 0),
    0,
  );

  return {
    status: 200,
    body: {
      universe_size: peggedAssets.length,
      top_n: top.length,
      top_n_total_supply_usd: totalSupply,
      stablecoins: top,
    },
  };
};
