/**
 * Bitcoin mempool real-time stats backed by mempool.space —
 * `/api/mempool` for size/fee histogram, `/api/blocks/tip/height`
 * for the latest mined block, and `/api/v1/difficulty-adjustment`
 * for the next-retarget estimate.
 *
 * Buyer pays the proxy ($0.005). All three reads run in parallel.
 * mempool.space already buckets the histogram by fee tier; we pass
 * it through verbatim (truncated to 50 buckets to bound response
 * size) so callers can compute their own confirmation-time
 * projection rather than relying on ours.
 *
 * No API key, public + free.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

const TIMEOUT_MS = 10_000;

interface MempoolStats {
  count?: number;
  vsize?: number;
  total_fee?: number;
  fee_histogram?: Array<[number, number]>;
}

interface DiffAdjustment {
  progressPercent?: number;
  difficultyChange?: number;
  estimatedRetargetDate?: number;
  remainingBlocks?: number;
  remainingTime?: number;
  previousRetarget?: number;
  nextRetargetHeight?: number;
  timeAvg?: number;
}

export const bitcoinMempoolStats: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  const fetcher = input.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  let mpRes: Response;
  let heightRes: Response;
  let diffRes: Response;
  try {
    [mpRes, heightRes, diffRes] = await Promise.all([
      fetcher("https://mempool.space/api/mempool", {
        method: "GET",
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      }),
      fetcher("https://mempool.space/api/blocks/tip/height", {
        method: "GET",
        headers: { accept: "text/plain" },
        signal: ctrl.signal,
      }),
      fetcher("https://mempool.space/api/v1/difficulty-adjustment", {
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

  for (const r of [mpRes, heightRes, diffRes]) {
    if (r.status === 429) {
      return { status: 503, body: { error: "rate_limit_upstream" } };
    }
    if (!r.ok) {
      return {
        status: 502,
        body: { error: "mempool_api_error", upstreamStatus: r.status },
      };
    }
  }

  let stats: MempoolStats;
  let tipHeight: number;
  let diff: DiffAdjustment;
  try {
    stats = (await mpRes.json()) as MempoolStats;
    const heightText = (await heightRes.text()).trim();
    tipHeight = Number(heightText);
    diff = (await diffRes.json()) as DiffAdjustment;
  } catch {
    return { status: 502, body: { error: "mempool_invalid_json" } };
  }

  const vsize = typeof stats.vsize === "number" ? stats.vsize : null;
  const totalFee = typeof stats.total_fee === "number" ? stats.total_fee : null;
  const count = typeof stats.count === "number" ? stats.count : null;
  const avgFeeRate =
    totalFee !== null && vsize !== null && vsize > 0
      ? Number((totalFee / vsize).toFixed(2))
      : null;

  return {
    status: 200,
    body: {
      chain: "bitcoin",
      tipHeight: Number.isFinite(tipHeight) ? tipHeight : null,
      mempool: {
        unconfirmedTxCount: count,
        totalVsize: vsize,
        totalVsizeMb:
          vsize !== null ? Number((vsize / 1_000_000).toFixed(2)) : null,
        totalFeeSats: totalFee,
        avgSatsPerVbyte: avgFeeRate,
      },
      feeHistogram: Array.isArray(stats.fee_histogram)
        ? stats.fee_histogram.slice(0, 50)
        : [],
      difficultyAdjustment: {
        progressPercent: diff.progressPercent ?? null,
        estimatedChange: diff.difficultyChange ?? null,
        estimatedRetargetMs: diff.estimatedRetargetDate ?? null,
        remainingBlocks: diff.remainingBlocks ?? null,
        remainingTimeMs: diff.remainingTime ?? null,
        previousRetargetChange: diff.previousRetarget ?? null,
        nextRetargetHeight: diff.nextRetargetHeight ?? null,
        avgBlockTimeSeconds: diff.timeAvg
          ? Number((diff.timeAvg / 1000).toFixed(1))
          : null,
      },
    },
  };
};
