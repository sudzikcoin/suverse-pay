/**
 * Bitcoin block info via mempool.space — `/api/block-height/{h}`
 * to resolve height → hash (when caller passes height), then
 * `/api/block/{hash}` for the detail payload, optionally followed
 * by `/api/block/{hash}/txids` for the full txid list.
 *
 * Buyer pays the proxy ($0.01). The handler accepts either `height`
 * (integer) or `hash` (64-hex) in the request body — exactly one,
 * not both. Total volume is computed lazily: mempool.space's block
 * endpoint doesn't carry it, so we fall back to NULL rather than
 * pull the full tx list to sum it (would cost a 3rd round-trip and
 * a large response). Total fees, miner pool, and tx count are all
 * present in the block detail directly.
 *
 * Pool identification falls back to NULL when mempool.space hasn't
 * tagged it — they cover most major pools but not private/solo
 * miners.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

const TIMEOUT_MS = 10_000;

interface MempoolBlockExtras {
  pool?: { id?: number; name?: string; slug?: string } | null;
  reward?: number;
  totalFees?: number;
  medianFee?: number;
  feeRange?: number[];
  avgFeeRate?: number;
  avgFee?: number;
  segwitTotalSize?: number;
  segwitTotalWeight?: number;
  segwitTotalTxs?: number;
  totalInputs?: number;
  totalOutputs?: number;
  utxoSetChange?: number;
}

interface MempoolBlock {
  id?: string;
  height?: number;
  version?: number;
  timestamp?: number;
  bits?: number;
  nonce?: number;
  difficulty?: number;
  merkle_root?: string;
  tx_count?: number;
  size?: number;
  weight?: number;
  previousblockhash?: string;
  mediantime?: number;
  extras?: MempoolBlockExtras;
}

export const bitcoinBlockInfo: InternalHandler = async (
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
    return { status: 400, body: { error: "height_or_hash_required" } };
  }
  const obj = parsed as Record<string, unknown>;
  const heightVal = obj["height"];
  const hashVal = obj["hash"];

  const hasHeight = typeof heightVal === "number" && Number.isInteger(heightVal) && heightVal >= 0;
  const hasHash = typeof hashVal === "string" && /^[0-9a-fA-F]{64}$/.test(hashVal);
  if (hasHeight === hasHash) {
    return {
      status: 400,
      body: { error: "supply_exactly_one_of_height_or_hash" },
    };
  }

  const fetcher = input.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  let blockHash: string;
  try {
    if (hasHash) {
      blockHash = (hashVal as string).toLowerCase();
    } else {
      const r = await fetcher(
        `https://mempool.space/api/block-height/${heightVal as number}`,
        { method: "GET", headers: { accept: "text/plain" }, signal: ctrl.signal },
      );
      if (r.status === 429) {
        clearTimeout(timer);
        return { status: 503, body: { error: "rate_limit_upstream" } };
      }
      if (r.status === 404) {
        clearTimeout(timer);
        return { status: 404, body: { error: "block_not_found" } };
      }
      if (!r.ok) {
        clearTimeout(timer);
        return {
          status: 502,
          body: { error: "mempool_api_error", upstreamStatus: r.status },
        };
      }
      blockHash = (await r.text()).trim();
      if (!/^[0-9a-fA-F]{64}$/.test(blockHash)) {
        clearTimeout(timer);
        return { status: 502, body: { error: "mempool_invalid_height_response" } };
      }
    }
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") {
      return { status: 504, body: { error: "mempool_timeout" } };
    }
    return { status: 502, body: { error: "mempool_unreachable" } };
  }

  let blockRes: Response;
  let txidsRes: Response;
  try {
    [blockRes, txidsRes] = await Promise.all([
      fetcher(`https://mempool.space/api/block/${blockHash}`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      }),
      fetcher(`https://mempool.space/api/block/${blockHash}/txids`, {
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

  if (blockRes.status === 429 || txidsRes.status === 429) {
    return { status: 503, body: { error: "rate_limit_upstream" } };
  }
  if (blockRes.status === 404) {
    return { status: 404, body: { error: "block_not_found" } };
  }
  if (!blockRes.ok) {
    return {
      status: 502,
      body: { error: "mempool_api_error", upstreamStatus: blockRes.status },
    };
  }

  let block: MempoolBlock;
  let txids: string[] = [];
  try {
    block = (await blockRes.json()) as MempoolBlock;
    if (txidsRes.ok) {
      const raw = (await txidsRes.json()) as unknown;
      if (Array.isArray(raw)) {
        txids = raw.filter((t): t is string => typeof t === "string");
      }
    }
  } catch {
    return { status: 502, body: { error: "mempool_invalid_json" } };
  }

  return {
    status: 200,
    body: {
      chain: "bitcoin",
      hash: block.id ?? blockHash,
      height: typeof block.height === "number" ? block.height : null,
      version: typeof block.version === "number" ? block.version : null,
      timestamp: typeof block.timestamp === "number" ? block.timestamp : null,
      medianTime: typeof block.mediantime === "number" ? block.mediantime : null,
      previousBlockHash: block.previousblockhash ?? null,
      merkleRoot: block.merkle_root ?? null,
      difficulty: typeof block.difficulty === "number" ? block.difficulty : null,
      bits: typeof block.bits === "number" ? block.bits : null,
      nonce: typeof block.nonce === "number" ? block.nonce : null,
      sizeBytes: typeof block.size === "number" ? block.size : null,
      weight: typeof block.weight === "number" ? block.weight : null,
      txCount: typeof block.tx_count === "number" ? block.tx_count : null,
      totalFeesSats: block.extras?.totalFees ?? null,
      avgFeeRate: block.extras?.avgFeeRate ?? null,
      medianFeeRate: block.extras?.medianFee ?? null,
      minerPool: block.extras?.pool?.name ?? null,
      minerPoolSlug: block.extras?.pool?.slug ?? null,
      rewardSats: block.extras?.reward ?? null,
      utxoSetChange: block.extras?.utxoSetChange ?? null,
      txidCount: txids.length,
      txids: txids.slice(0, 100),
      txidsTruncated: txids.length > 100,
    },
  };
};
