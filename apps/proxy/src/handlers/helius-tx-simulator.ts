/**
 * Solana transaction simulator backed by Helius RPC `simulateTransaction`.
 *
 * Buyer pays the proxy ($0.10), then we ask Helius to dry-run the
 * supplied base64 transaction against current state and return the
 * outcome: success/failure, compute units, program logs, and any
 * touched accounts. No on-chain broadcast happens.
 *
 * `replaceRecentBlockhash: true` lets the buyer submit a tx that was
 * built minutes ago without it being rejected as "stale blockhash"
 * — the simulator substitutes a fresh blockhash before running.
 *
 * `sigVerify: false` is the conscious tradeoff: the caller is asking
 * "would this work?" not "is this signed correctly?". Forcing them to
 * sign before simulating means they can't even ask the question
 * without locking in a fee.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
  InternalHandlerValidator,
} from "./types.js";

/**
 * Pre-payment validator for `helius_tx_simulator`. Rejects empty
 * bodies, non-JSON bodies, and bodies missing a plausible base64
 * `transaction` field BEFORE the 402 challenge is issued. Bots
 * probing with `{}` or random bytes get a 400 and stop retrying,
 * which keeps the error rate clean for paid callers.
 *
 * Threshold reasoning: a Solana transaction wire blob starts with a
 * compact-array of 64-byte signatures plus the message; the minimum
 * legal length (1 sig + a trivial transfer) base64-encodes to >=120
 * chars. We reject anything below 100 chars as bot garbage.
 */
export const heliusTxSimulatorValidator: InternalHandlerValidator = (
  body,
  method,
) => {
  if (method !== "POST") return null;
  if (!body || body.length === 0) {
    return { status: 400, body: { error: "transaction_required" } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { status: 400, body: { error: "invalid_json_body" } };
  }
  const tx =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)["transaction"]
      : undefined;
  if (typeof tx !== "string" || tx.length === 0) {
    return { status: 400, body: { error: "transaction_required" } };
  }
  if (tx.length < 100) {
    return {
      status: 400,
      body: {
        error: "transaction_too_short",
        message: "base64 transaction is shorter than a minimal Solana tx",
      },
    };
  }
  if (!/^[A-Za-z0-9+/]+=*$/.test(tx)) {
    return {
      status: 400,
      body: {
        error: "transaction_not_base64",
        message: "transaction field must be base64-encoded",
      },
    };
  }
  return null;
};

interface SimulateResult {
  err?: unknown;
  logs?: string[];
  accounts?: unknown[];
  unitsConsumed?: number;
}

interface RpcResponse {
  result?: { value?: SimulateResult } | null;
  error?: { code?: number; message?: string };
}

export const heliusTxSimulator: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  const apiKey = process.env["HELIUS_API_KEY"];
  if (!apiKey) {
    return { status: 503, body: { error: "helius_not_configured" } };
  }

  let parsed: unknown;
  try {
    parsed =
      input.body && input.body.length > 0
        ? JSON.parse(input.body.toString("utf8"))
        : null;
  } catch {
    return { status: 400, body: { error: "invalid_json_body" } };
  }

  const tx =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)["transaction"]
      : undefined;

  if (typeof tx !== "string" || tx.length === 0) {
    return { status: 400, body: { error: "transaction_required" } };
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
        method: "simulateTransaction",
        params: [
          tx,
          {
            encoding: "base64",
            sigVerify: false,
            replaceRecentBlockhash: true,
            commitment: "processed",
          },
        ],
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
      status: 400,
      body: {
        error: "simulation_rpc_error",
        code: data.error.code ?? null,
        message: data.error.message ?? null,
      },
    };
  }

  const value = data.result?.value;
  if (!value) {
    return { status: 502, body: { error: "helius_empty_result" } };
  }

  return {
    status: 200,
    body: {
      success: value.err === null || value.err === undefined,
      error: value.err ?? null,
      logs: value.logs ?? [],
      computeUnits: value.unitsConsumed ?? null,
      accountsTouched: value.accounts ?? [],
    },
  };
};
