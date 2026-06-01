/**
 * Solana priority-fee oracle backed by Helius RPC
 * `getPriorityFeeEstimate`.
 *
 * Buyer pays the proxy ($0.01), then we ask Helius for the current
 * micro-lamports/CU recommendation at every percentile band. The
 * caller decides which band to use (`medium` for normal UX, `high`
 * for trading bots, `veryHigh` for time-critical inclusion).
 *
 * `accountKeys` (optional) lets the caller tailor the estimate to the
 * specific accounts their tx will touch — congestion is per-write-lock,
 * not global, so a tx touching only cold accounts gets a lower
 * recommendation than the network-wide median. With no accounts the
 * estimate is the global default — fine for naive callers.
 *
 * `includeAllPriorityFeeLevels: true` is the whole reason this endpoint
 * is useful — without it Helius returns just one number and the caller
 * has no way to make a cost/speed tradeoff.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

interface PriorityFeeLevels {
  min?: number;
  low?: number;
  medium?: number;
  high?: number;
  veryHigh?: number;
  unsafeMax?: number;
}

interface RpcResponse {
  result?: {
    priorityFeeLevels?: PriorityFeeLevels;
    priorityFeeEstimate?: number;
  };
  error?: { code?: number; message?: string };
}

export const heliusPriorityFee: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  const apiKey = process.env["HELIUS_API_KEY"];
  if (!apiKey) {
    return { status: 503, body: { error: "helius_not_configured" } };
  }

  let parsed: unknown = null;
  if (input.body && input.body.length > 0) {
    try {
      parsed = JSON.parse(input.body.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "invalid_json_body" } };
    }
  }

  const accountKeys =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)["accountKeys"]
      : undefined;

  const paramObject: Record<string, unknown> = {
    options: { includeAllPriorityFeeLevels: true },
  };
  if (Array.isArray(accountKeys) && accountKeys.length > 0) {
    if (!accountKeys.every((k) => typeof k === "string")) {
      return { status: 400, body: { error: "account_keys_must_be_strings" } };
    }
    paramObject["accountKeys"] = accountKeys;
  }

  const url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getPriorityFeeEstimate",
        params: [paramObject],
      }),
    });
  } catch {
    return { status: 502, body: { error: "helius_unreachable" } };
  }

  if (!response.ok) {
    return {
      status: 502,
      body: { error: "helius_api_error", upstreamStatus: response.status },
    };
  }

  let data: RpcResponse;
  try {
    data = (await response.json()) as RpcResponse;
  } catch {
    return { status: 502, body: { error: "helius_invalid_json" } };
  }

  if (data.error) {
    return {
      status: 502,
      body: {
        error: "priority_fee_rpc_error",
        code: data.error.code ?? null,
        message: data.error.message ?? null,
      },
    };
  }

  const result = data.result ?? {};
  return {
    status: 200,
    body: {
      priorityFeeLevels: result.priorityFeeLevels ?? null,
      priorityFeeEstimate: result.priorityFeeEstimate ?? null,
    },
  };
};
