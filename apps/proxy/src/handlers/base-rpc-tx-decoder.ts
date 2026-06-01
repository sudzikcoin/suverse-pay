/**
 * Base chain transaction decoder backed by the public Base RPC at
 * mainnet.base.org. We deliberately do NOT use Etherscan V2 here —
 * the free Etherscan tier no longer covers chains other than
 * Ethereum mainnet (proxy + account modules), and we want this
 * endpoint to be usable without any seller-side billing.
 *
 * Buyer pays the proxy ($0.05); we fan out two parallel RPC calls
 * (eth_getTransactionByHash + eth_getTransactionReceipt) and fold
 * them into a single payload — basics, gas usage, success flag, plus
 * best-effort ERC-20 Transfer log extraction via the canonical
 * topic `0xddf252ad...`. Full ABI decode is intentionally out of
 * scope; callers who need it can use the methodId + token list as
 * inputs to their own 4byte/Sourcify lookup.
 *
 * mainnet.base.org has a soft per-IP cap; on 429 we map to 503 so
 * callers retry rather than see a confusing 4xx.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

const TIMEOUT_MS = 10_000;
const RPC_URL = "https://mainnet.base.org";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

interface RpcTx {
  hash?: string;
  from?: string;
  to?: string | null;
  value?: string;
  gas?: string;
  gasPrice?: string;
  input?: string;
  blockNumber?: string;
  nonce?: string;
  type?: string;
}

interface RpcReceipt {
  status?: string;
  gasUsed?: string;
  effectiveGasPrice?: string;
  contractAddress?: string | null;
  logs?: Array<{
    address?: string;
    topics?: string[];
    data?: string;
  }>;
}

interface RpcEnvelope<T> {
  jsonrpc?: string;
  id?: number | string;
  result?: T | null;
  error?: { code?: number; message?: string };
}

function hexToBig(v: string | undefined | null): bigint | null {
  if (typeof v !== "string" || !v.startsWith("0x")) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

function hexToNum(v: string | undefined): number | null {
  const b = hexToBig(v);
  return b === null ? null : Number(b);
}

function topicToAddress(topic: string | undefined): string | null {
  if (typeof topic !== "string" || topic.length < 26) return null;
  return "0x" + topic.slice(topic.length - 40);
}

export const baseRpcTxDecoder: InternalHandler = async (
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
    return { status: 400, body: { error: "tx_hash_required" } };
  }
  const txHash = (parsed as Record<string, unknown>)["tx_hash"];
  if (typeof txHash !== "string" || txHash.length === 0) {
    return { status: 400, body: { error: "tx_hash_required" } };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { status: 400, body: { error: "invalid_tx_hash_format" } };
  }

  const fetcher = input.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  const txBody = JSON.stringify({
    jsonrpc: "2.0",
    method: "eth_getTransactionByHash",
    params: [txHash],
    id: 1,
  });
  const rcBody = JSON.stringify({
    jsonrpc: "2.0",
    method: "eth_getTransactionReceipt",
    params: [txHash],
    id: 2,
  });

  let txRes: Response;
  let rcRes: Response;
  try {
    [txRes, rcRes] = await Promise.all([
      fetcher(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: txBody,
        signal: ctrl.signal,
      }),
      fetcher(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rcBody,
        signal: ctrl.signal,
      }),
    ]);
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") {
      return { status: 504, body: { error: "rpc_timeout" } };
    }
    return { status: 502, body: { error: "rpc_unreachable" } };
  }
  clearTimeout(timer);

  if (txRes.status === 429 || rcRes.status === 429) {
    return { status: 503, body: { error: "rate_limit_upstream" } };
  }
  if (!txRes.ok || !rcRes.ok) {
    return {
      status: 502,
      body: {
        error: "rpc_api_error",
        upstreamStatus: txRes.ok ? rcRes.status : txRes.status,
      },
    };
  }

  let txEnv: RpcEnvelope<RpcTx>;
  let rcEnv: RpcEnvelope<RpcReceipt>;
  try {
    txEnv = (await txRes.json()) as RpcEnvelope<RpcTx>;
    rcEnv = (await rcRes.json()) as RpcEnvelope<RpcReceipt>;
  } catch {
    return { status: 502, body: { error: "rpc_invalid_json" } };
  }

  const tx = txEnv.result;
  const rc = rcEnv.result;
  if (!tx || !rc) {
    return { status: 404, body: { error: "transaction_not_found" } };
  }

  const transfers = (rc.logs ?? [])
    .filter((l) => Array.isArray(l.topics) && l.topics[0] === TRANSFER_TOPIC)
    .map((l) => {
      const topics = l.topics ?? [];
      return {
        token: l.address ?? null,
        from: topicToAddress(topics[1]),
        to: topicToAddress(topics[2]),
        rawAmount: typeof l.data === "string" ? l.data : null,
      };
    });

  const gasUsed = hexToBig(rc.gasUsed);
  const effGasPrice = hexToBig(rc.effectiveGasPrice);
  const gasCostWei =
    gasUsed !== null && effGasPrice !== null ? gasUsed * effGasPrice : null;
  const valueWei = hexToBig(tx.value);

  return {
    status: 200,
    body: {
      chain: "base",
      chainId: 8453,
      hash: tx.hash ?? txHash,
      from: tx.from ?? null,
      to: tx.to ?? null,
      valueWei: valueWei?.toString() ?? null,
      valueEth: valueWei !== null ? Number(valueWei) / 1e18 : null,
      input: tx.input ?? null,
      methodId:
        typeof tx.input === "string" && tx.input.length >= 10
          ? tx.input.slice(0, 10)
          : null,
      blockNumber: hexToNum(tx.blockNumber),
      nonce: hexToNum(tx.nonce),
      status: rc.status === "0x1" ? "success" : "failed",
      gasUsed: gasUsed?.toString() ?? null,
      effectiveGasPriceWei: effGasPrice?.toString() ?? null,
      gasCostWei: gasCostWei?.toString() ?? null,
      gasCostEth: gasCostWei !== null ? Number(gasCostWei) / 1e18 : null,
      contractCreated: rc.contractAddress ?? null,
      erc20Transfers: transfers,
      transferCount: transfers.length,
      summary:
        transfers.length > 0
          ? `${transfers.length} ERC20 transfer(s) on Base`
          : tx.to
            ? `Call to ${tx.to}`
            : "Contract creation",
    },
  };
};
