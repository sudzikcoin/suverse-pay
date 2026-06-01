/**
 * Bitcoin recommended fees backed by mempool.space
 * (`/api/v1/fees/recommended` + `/api/mempool`).
 *
 * Buyer pays the proxy ($0.005). Two parallel reads — the fee
 * percentile bucket the team at mempool.space publishes
 * (fastestFee, halfHourFee, hourFee, economyFee, minimumFee) and
 * the current raw mempool stats (count, vsize, total_fee) — so a
 * single response gives both the "what should I pay" answer and the
 * congestion context behind it.
 *
 * Free + unauth; on 429 we surface 503 so callers retry.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

const TIMEOUT_MS = 10_000;

interface RecommendedFees {
  fastestFee?: number;
  halfHourFee?: number;
  hourFee?: number;
  economyFee?: number;
  minimumFee?: number;
}

interface MempoolStats {
  count?: number;
  vsize?: number;
  total_fee?: number;
  fee_histogram?: Array<[number, number]>;
}

export const bitcoinFeesRecommended: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  const fetcher = input.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  let feesRes: Response;
  let mempoolRes: Response;
  try {
    [feesRes, mempoolRes] = await Promise.all([
      fetcher("https://mempool.space/api/v1/fees/recommended", {
        method: "GET",
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      }),
      fetcher("https://mempool.space/api/mempool", {
        method: "GET",
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      }),
    ]);
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") {
      return { status: 504, body: { error: "mempool_timeout" } };
    }
    return { status: 502, body: { error: "mempool_unreachable" } };
  }
  clearTimeout(timer);

  if (feesRes.status === 429 || mempoolRes.status === 429) {
    return { status: 503, body: { error: "rate_limit_upstream" } };
  }
  if (!feesRes.ok || !mempoolRes.ok) {
    return {
      status: 502,
      body: {
        error: "mempool_api_error",
        upstreamStatus: feesRes.ok ? mempoolRes.status : feesRes.status,
      },
    };
  }

  let fees: RecommendedFees;
  let stats: MempoolStats;
  try {
    fees = (await feesRes.json()) as RecommendedFees;
    stats = (await mempoolRes.json()) as MempoolStats;
  } catch {
    return { status: 502, body: { error: "mempool_invalid_json" } };
  }

  const vsize = typeof stats.vsize === "number" ? stats.vsize : null;

  return {
    status: 200,
    body: {
      chain: "bitcoin",
      satsPerVbyte: {
        fastest: fees.fastestFee ?? null,
        halfHour: fees.halfHourFee ?? null,
        hour: fees.hourFee ?? null,
        economy: fees.economyFee ?? null,
        minimum: fees.minimumFee ?? null,
      },
      mempool: {
        unconfirmedTxCount: stats.count ?? null,
        totalVsize: vsize,
        totalVsizeMb: vsize !== null ? Number((vsize / 1_000_000).toFixed(2)) : null,
        totalFeeSats: stats.total_fee ?? null,
      },
      feeHistogram: Array.isArray(stats.fee_histogram)
        ? stats.fee_histogram.slice(0, 50)
        : [],
    },
  };
};
