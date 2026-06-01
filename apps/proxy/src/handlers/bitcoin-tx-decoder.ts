/**
 * Bitcoin transaction decoder backed by mempool.space
 * (`/api/tx/{txid}`).
 *
 * Buyer pays the proxy ($0.05); we fetch a single rich tx object
 * and fold it into a portfolio-friendly shape: inputs (with previous
 * output address + value), outputs (with address + value), totals,
 * fee in sats + sats/vbyte, confirmation status, block height,
 * timestamp, plus pattern flags — coinbase, RBF-signaled, OP_RETURN
 * present, segwit/taproot script types observed.
 *
 * mempool.space is public + no auth; on 429 we surface 503 to give
 * callers a retryable signal.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

const TIMEOUT_MS = 10_000;

interface MempoolVin {
  txid?: string;
  vout?: number;
  is_coinbase?: boolean;
  sequence?: number;
  prevout?: {
    scriptpubkey?: string;
    scriptpubkey_type?: string;
    scriptpubkey_address?: string;
    value?: number;
  } | null;
}

interface MempoolVout {
  scriptpubkey?: string;
  scriptpubkey_type?: string;
  scriptpubkey_address?: string;
  value?: number;
}

interface MempoolStatus {
  confirmed?: boolean;
  block_height?: number;
  block_hash?: string;
  block_time?: number;
}

interface MempoolTx {
  txid?: string;
  version?: number;
  locktime?: number;
  size?: number;
  weight?: number;
  fee?: number;
  vin?: MempoolVin[];
  vout?: MempoolVout[];
  status?: MempoolStatus;
}

export const bitcoinTxDecoder: InternalHandler = async (
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
    return { status: 400, body: { error: "txid_required" } };
  }
  const txid = (parsed as Record<string, unknown>)["txid"];
  if (typeof txid !== "string" || !/^[0-9a-fA-F]{64}$/.test(txid)) {
    return { status: 400, body: { error: "invalid_txid_format" } };
  }

  const url = `https://mempool.space/api/tx/${txid}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") {
      return { status: 504, body: { error: "mempool_timeout" } };
    }
    return { status: 502, body: { error: "mempool_unreachable" } };
  }
  clearTimeout(timer);

  if (response.status === 429) {
    return { status: 503, body: { error: "rate_limit_upstream" } };
  }
  if (response.status === 404) {
    return { status: 404, body: { error: "transaction_not_found" } };
  }
  if (!response.ok) {
    return {
      status: 502,
      body: { error: "mempool_api_error", upstreamStatus: response.status },
    };
  }

  let tx: MempoolTx;
  try {
    tx = (await response.json()) as MempoolTx;
  } catch {
    return { status: 502, body: { error: "mempool_invalid_json" } };
  }

  const vins = tx.vin ?? [];
  const vouts = tx.vout ?? [];

  const inputs = vins.map((v) => ({
    txid: v.txid ?? null,
    vout: typeof v.vout === "number" ? v.vout : null,
    address: v.prevout?.scriptpubkey_address ?? null,
    valueSats: v.prevout?.value ?? null,
    scriptType: v.prevout?.scriptpubkey_type ?? null,
    sequence: typeof v.sequence === "number" ? v.sequence : null,
  }));
  const outputs = vouts.map((v) => ({
    address: v.scriptpubkey_address ?? null,
    valueSats: typeof v.value === "number" ? v.value : null,
    scriptType: v.scriptpubkey_type ?? null,
  }));

  const totalInputSats = inputs.reduce(
    (acc, i) => acc + (i.valueSats ?? 0),
    0,
  );
  const totalOutputSats = outputs.reduce(
    (acc, o) => acc + (o.valueSats ?? 0),
    0,
  );

  const isCoinbase = vins.some((v) => v.is_coinbase === true);
  const hasOpReturn = outputs.some((o) => o.scriptType === "op_return");
  const isRbfSignaled = vins.some(
    (v) => typeof v.sequence === "number" && v.sequence < 0xfffffffe,
  );
  const scriptTypes = new Set<string>();
  for (const i of inputs) if (i.scriptType) scriptTypes.add(i.scriptType);
  for (const o of outputs) if (o.scriptType) scriptTypes.add(o.scriptType);
  const hasTaproot = scriptTypes.has("v1_p2tr");
  const hasSegwit =
    scriptTypes.has("v0_p2wpkh") || scriptTypes.has("v0_p2wsh");

  const feeSats = typeof tx.fee === "number" ? tx.fee : null;
  const vsize =
    typeof tx.weight === "number" ? Math.ceil(tx.weight / 4) : null;
  const satsPerVbyte =
    feeSats !== null && vsize !== null && vsize > 0
      ? Number((feeSats / vsize).toFixed(2))
      : null;

  return {
    status: 200,
    body: {
      chain: "bitcoin",
      txid: tx.txid ?? txid,
      version: typeof tx.version === "number" ? tx.version : null,
      locktime: typeof tx.locktime === "number" ? tx.locktime : null,
      sizeBytes: typeof tx.size === "number" ? tx.size : null,
      weight: typeof tx.weight === "number" ? tx.weight : null,
      vsize,
      feeSats,
      satsPerVbyte,
      isCoinbase,
      isRbfSignaled,
      hasOpReturn,
      hasTaproot,
      hasSegwit,
      confirmed: tx.status?.confirmed === true,
      blockHeight: tx.status?.block_height ?? null,
      blockTime: tx.status?.block_time ?? null,
      blockHash: tx.status?.block_hash ?? null,
      inputCount: inputs.length,
      outputCount: outputs.length,
      totalInputSats: isCoinbase ? null : totalInputSats,
      totalOutputSats,
      totalInputBtc: isCoinbase ? null : totalInputSats / 1e8,
      totalOutputBtc: totalOutputSats / 1e8,
      inputs,
      outputs,
    },
  };
};
