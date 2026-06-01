/**
 * Top DeFi yield pools backed by DeFiLlama Yields
 * (`https://yields.llama.fi/pools`). Buyer pays the proxy ($0.03),
 * then we filter the full pool universe by minimum TVL, sort by
 * APY desc, and return the top N (capped at 50).
 *
 * The TVL floor is a deliberate guard — DeFiLlama indexes
 * pump-and-dump 4-digit-APY pools with <$10k TVL; serving those
 * raw to a yield-farming agent is malpractice. Default $1M
 * matches the buyer-side floor most automation already applies.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

interface YieldPool {
  pool?: string;
  chain?: string;
  project?: string;
  symbol?: string;
  tvlUsd?: number;
  apy?: number | null;
  apyBase?: number | null;
  apyReward?: number | null;
  ilRisk?: string;
  stablecoin?: boolean;
  exposure?: string;
}

const DEFAULT_MIN_TVL = 1_000_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;
const TIMEOUT_MS = 10_000;

export const defillamaYieldPools: InternalHandler = async (
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

  let minTvl = DEFAULT_MIN_TVL;
  let limit = DEFAULT_LIMIT;
  if (parsed !== null && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const rawTvl = obj["min_tvl"];
    if (rawTvl !== undefined) {
      if (typeof rawTvl !== "number" || !Number.isFinite(rawTvl) || rawTvl < 0) {
        return { status: 400, body: { error: "invalid_min_tvl" } };
      }
      minTvl = rawTvl;
    }
    const rawLimit = obj["limit"];
    if (rawLimit !== undefined) {
      if (
        typeof rawLimit !== "number" ||
        !Number.isInteger(rawLimit) ||
        rawLimit < 1
      ) {
        return { status: 400, body: { error: "invalid_limit" } };
      }
      limit = Math.min(rawLimit, MAX_LIMIT);
    }
  }

  const url = "https://yields.llama.fi/pools";
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

  let json: { data?: YieldPool[] };
  try {
    json = (await response.json()) as { data?: YieldPool[] };
  } catch {
    return { status: 502, body: { error: "upstream_invalid_json" } };
  }
  const rawPools = Array.isArray(json.data) ? json.data : [];

  const filtered = rawPools
    .filter(
      (p) =>
        typeof p.tvlUsd === "number" &&
        p.tvlUsd >= minTvl &&
        typeof p.apy === "number",
    )
    .sort((a, b) => (b.apy ?? 0) - (a.apy ?? 0))
    .slice(0, limit)
    .map((p) => ({
      pool_id: p.pool ?? null,
      symbol: p.symbol ?? null,
      project: p.project ?? null,
      chain: p.chain ?? null,
      tvl_usd: p.tvlUsd ?? null,
      apy: p.apy ?? null,
      apy_base: p.apyBase ?? null,
      apy_reward: p.apyReward ?? null,
      il_risk: p.ilRisk ?? null,
      stablecoin: p.stablecoin ?? null,
      exposure: p.exposure ?? null,
    }));

  return {
    status: 200,
    body: {
      min_tvl: minTvl,
      limit,
      universe_size: rawPools.length,
      count: filtered.length,
      pools: filtered,
    },
  };
};
