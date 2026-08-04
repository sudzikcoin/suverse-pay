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
import {
  heliusConfigured,
  heliusErrorToResult,
  heliusFetch,
} from "../lib/helius-client.js";
import { classifyRequiredStringField } from "./discovery.js";
import type { InternalHandlerInputSchema } from "./discovery.js";
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerPreflight,
  InternalHandlerResult,
  InternalHandlerValidator,
} from "./types.js";

/**
 * Is this a plausible base64 Solana transaction wire blob?
 *
 * Threshold reasoning: a Solana transaction starts with a compact-array
 * of 64-byte signatures plus the message; the minimum legal length
 * (1 sig + a trivial transfer) base64-encodes to >=120 chars. Anything
 * below 100 chars cannot be a real transaction.
 */
function isBase64Transaction(v: string): boolean {
  if (v.length < 100) return false;
  return /^[A-Za-z0-9+/]+=*$/.test(v);
}

/**
 * Machine-readable input contract published on the 402 challenge, so a
 * schema-blind crawler learns the required field without paying first.
 */
export const heliusTxSimulatorInputSchema: InternalHandlerInputSchema = {
  method: "POST",
  content_type: "application/json",
  body: {
    type: "object",
    required: ["transaction"],
    properties: {
      transaction: {
        type: "string",
        description:
          "Base64-encoded Solana transaction wire blob to dry-run (min 100 chars). Required.",
        pattern: "^[A-Za-z0-9+/]+=*$",
      },
    },
  },
  example: {
    transaction: `${"A".repeat(160)}==`,
  },
};

/**
 * Pre-payment validator for `helius_tx_simulator`.
 *
 * Follows the shared decision table in `discovery.ts`: an empty,
 * missing or placeholder `transaction` is a DISCOVERY probe and must
 * fall through to the 402 challenge (which carries price +
 * `input_schema`), NOT get a 400. Only a real-but-wrong blob is
 * rejected here.
 *
 * Before 2026-08-04 this returned 400 on an empty body, which meant
 * catalog crawlers and schema fetchers never saw the 402 at all.
 * `heliusTxSimulatorPreflight` is what keeps a PAID empty body from
 * settling now that the validator lets probes through.
 */
export const heliusTxSimulatorValidator: InternalHandlerValidator = (
  body,
  method,
) => {
  if (method !== "POST") return null;
  const c = classifyRequiredStringField(
    body,
    "transaction",
    isBase64Transaction,
  );
  switch (c.kind) {
    case "discovery":
    case "valid":
      return null;
    case "invalid_json":
      return { status: 400, body: { error: "invalid_json_body" } };
    case "malformed":
      return {
        status: 422,
        body: {
          error: "transaction_required",
          expected: '{"transaction":"<base64 Solana transaction>"}',
        },
      };
    case "invalid_value":
      return {
        status: 422,
        body: {
          error: "invalid_transaction_format",
          detail:
            "transaction must be a base64-encoded Solana transaction of at least 100 chars",
          expected: heliusTxSimulatorInputSchema.example,
        },
      };
  }
};

/**
 * Pre-SETTLEMENT gate. The validator deliberately lets discovery
 * probes through to the 402; this runs only once a payment header is
 * present, so a buyer who pays with an empty/placeholder body is
 * refused BEFORE settlement instead of being charged for a call the
 * handler could never answer.
 */
export const heliusTxSimulatorPreflight: InternalHandlerPreflight = async (
  input,
) => {
  const c = classifyRequiredStringField(
    input.body,
    "transaction",
    isBase64Transaction,
  );
  if (c.kind === "valid") return { proceed: true };
  return {
    proceed: false,
    status: 422,
    body: {
      error: "transaction_required",
      detail:
        "a base64-encoded Solana transaction (min 100 chars) is required",
      input_schema: heliusTxSimulatorInputSchema,
    },
  };
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
  if (!heliusConfigured()) {
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

  let response: Response;
  try {
    response = await heliusFetch(
      (apiKey) =>
        `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`,
      {
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
      },
      { fetchImpl: input.fetchImpl },
    );
  } catch (err) {
    return heliusErrorToResult(err);
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
