/**
 * Bitcoin address balance + recent history via mempool.space
 * (`/api/address/{addr}` + `/api/address/{addr}/txs`).
 *
 * Buyer pays the proxy ($0.05). Two parallel reads — address
 * stats (funded/spent totals across confirmed + mempool, tx count)
 * and the last ~25 transactions sorted newest-first by mempool.space.
 * Each tx is folded down to hash + fee + confirmation + size; the
 * full vin/vout payload is intentionally dropped so the response
 * stays small.
 *
 * Address-type detection is best-effort from the bech32 prefix
 * (legacy `1`, P2SH `3`, SegWit `bc1q`, Taproot `bc1p`).
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

const TIMEOUT_MS = 10_000;

interface MempoolAddrInfo {
  address?: string;
  chain_stats?: {
    funded_txo_count?: number;
    funded_txo_sum?: number;
    spent_txo_count?: number;
    spent_txo_sum?: number;
    tx_count?: number;
  };
  mempool_stats?: {
    funded_txo_count?: number;
    funded_txo_sum?: number;
    spent_txo_count?: number;
    spent_txo_sum?: number;
    tx_count?: number;
  };
}

interface MempoolAddrTx {
  txid?: string;
  fee?: number;
  size?: number;
  weight?: number;
  status?: {
    confirmed?: boolean;
    block_height?: number;
    block_time?: number;
  };
}

function classifyAddress(addr: string): string {
  if (addr.startsWith("bc1p")) return "p2tr";
  if (addr.startsWith("bc1q")) return "p2wpkh";
  if (addr.startsWith("3")) return "p2sh";
  if (addr.startsWith("1")) return "p2pkh";
  return "unknown";
}

export const bitcoinAddressInfo: InternalHandler = async (
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
    return { status: 400, body: { error: "address_required" } };
  }
  const addr = (parsed as Record<string, unknown>)["address"];
  if (typeof addr !== "string" || addr.length < 25 || addr.length > 90) {
    return { status: 400, body: { error: "invalid_address" } };
  }

  const fetcher = input.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  let infoRes: Response;
  let txsRes: Response;
  try {
    [infoRes, txsRes] = await Promise.all([
      fetcher(`https://mempool.space/api/address/${addr}`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      }),
      fetcher(`https://mempool.space/api/address/${addr}/txs`, {
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

  if (infoRes.status === 429 || txsRes.status === 429) {
    return { status: 503, body: { error: "rate_limit_upstream" } };
  }
  if (infoRes.status === 400 || infoRes.status === 404) {
    return { status: 404, body: { error: "address_not_found" } };
  }
  if (!infoRes.ok || !txsRes.ok) {
    return {
      status: 502,
      body: {
        error: "mempool_api_error",
        upstreamStatus: infoRes.ok ? txsRes.status : infoRes.status,
      },
    };
  }

  let info: MempoolAddrInfo;
  let txs: MempoolAddrTx[];
  try {
    info = (await infoRes.json()) as MempoolAddrInfo;
    txs = (await txsRes.json()) as MempoolAddrTx[];
  } catch {
    return { status: 502, body: { error: "mempool_invalid_json" } };
  }

  const cs = info.chain_stats ?? {};
  const ms = info.mempool_stats ?? {};
  const confirmedBalance = (cs.funded_txo_sum ?? 0) - (cs.spent_txo_sum ?? 0);
  const unconfirmedDelta = (ms.funded_txo_sum ?? 0) - (ms.spent_txo_sum ?? 0);
  const totalBalance = confirmedBalance + unconfirmedDelta;

  const recent = txs.slice(0, 20).map((t) => ({
    txid: t.txid ?? null,
    feeSats: t.fee ?? null,
    sizeBytes: t.size ?? null,
    weight: t.weight ?? null,
    confirmed: t.status?.confirmed === true,
    blockHeight: t.status?.block_height ?? null,
    blockTime: t.status?.block_time ?? null,
  }));

  return {
    status: 200,
    body: {
      chain: "bitcoin",
      address: addr,
      addressType: classifyAddress(addr),
      confirmedBalanceSats: confirmedBalance,
      confirmedBalanceBtc: confirmedBalance / 1e8,
      unconfirmedBalanceSats: unconfirmedDelta,
      totalBalanceSats: totalBalance,
      totalBalanceBtc: totalBalance / 1e8,
      confirmedTxCount: cs.tx_count ?? 0,
      mempoolTxCount: ms.tx_count ?? 0,
      totalReceivedSats: cs.funded_txo_sum ?? 0,
      totalSpentSats: cs.spent_txo_sum ?? 0,
      recentTxCount: recent.length,
      recentTransactions: recent,
    },
  };
};
