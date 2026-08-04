/**
 * Solana transaction decoder backed by Helius Enhanced Transactions API.
 *
 * SuVerse is the service provider here — no upstream x402 payment.
 * Buyer pays us via the standard proxy flow ($0.05), then we call
 * Helius with our own API key and return a normalized decoded payload
 * shaped like the previous OATP wrap response so downstream agents
 * that worked against `/v1/data/solana-tx-decoder` keep working when
 * pointed at the new endpoint.
 *
 * Free tier (1M credits/mo) is more than enough for v1 traffic; the
 * key lives in HELIUS_API_KEY on the proxy process.
 *
 * Per CLAUDE.md, no business logic lives in provider adapters. This
 * file is the in-process equivalent of a provider adapter — it
 * translates Helius's raw response shape into the gateway-native
 * contract. No routing, no fee math, no policy.
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
 * Is this a plausible Solana transaction signature? 64-byte Ed25519
 * sigs encode to 86–88 base58 chars in practice; we accept a generous
 * 64–128 window to leave room for unusual encodings. The handler
 * re-checks more strictly after payment.
 */
function isSolanaSignature(v: string): boolean {
  if (v.length < 64 || v.length > 128) return false;
  // base58 alphabet (no 0, O, I, l).
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(v);
}

/**
 * Machine-readable input contract published on the 402 challenge, so a
 * schema-blind crawler (or `dexter-api/x402-schema-fetcher`) learns the
 * required field without paying first.
 */
export const heliusTxDecoderInputSchema: InternalHandlerInputSchema = {
  method: "POST",
  content_type: "application/json",
  body: {
    type: "object",
    required: ["signature"],
    properties: {
      signature: {
        type: "string",
        description:
          "Solana transaction signature (base58, 64-128 chars). Required.",
        pattern: "^[1-9A-HJ-NP-Za-km-z]{64,128}$",
      },
    },
  },
  example: {
    signature:
      "5h1cQx8mNQ2mBfZTMkQpKDkVLbHrQwvxAqPfP5j8XW7tR3vDgJ2sKcYnA9bUeM4fTz6NqLpVhWx1sRdCgB7yKuE3",
  },
};

/**
 * Pre-payment validator for `helius_tx_decoder`.
 *
 * Follows the shared decision table in `discovery.ts`: an empty,
 * missing or placeholder `signature` is a DISCOVERY probe and must fall
 * through to the 402 challenge (which carries price + `input_schema`),
 * NOT get a 400. Only a real-but-wrong signature is rejected here.
 *
 * Before 2026-08-04 this returned 400 on an empty body, which meant
 * catalog crawlers and schema fetchers never saw the 402 at all —
 * 568 rejections in 7 days across this handler and the simulator.
 * `heliusTxDecoderPreflight` is what keeps a PAID empty body from
 * settling now that the validator lets probes through.
 */
export const heliusTxDecoderValidator: InternalHandlerValidator = (
  body,
  method,
) => {
  if (method !== "POST") return null;
  const c = classifyRequiredStringField(body, "signature", isSolanaSignature);
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
          error: "signature_required",
          expected: '{"signature":"<base58 Solana tx signature>"}',
        },
      };
    case "invalid_value":
      return {
        status: 422,
        body: {
          error: "invalid_signature_format",
          detail:
            "signature must be a base58 Solana transaction signature (64-128 chars)",
          expected: heliusTxDecoderInputSchema.example,
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
export const heliusTxDecoderPreflight: InternalHandlerPreflight = async (
  input,
) => {
  const c = classifyRequiredStringField(
    input.body,
    "signature",
    isSolanaSignature,
  );
  if (c.kind === "valid") return { proceed: true };
  return {
    proceed: false,
    status: 422,
    body: {
      error: "signature_required",
      detail:
        "a base58 Solana transaction signature (64-128 chars) is required",
      input_schema: heliusTxDecoderInputSchema,
    },
  };
};

interface HeliusTokenTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  fromTokenAccount?: string;
  toTokenAccount?: string;
  mint?: string;
  tokenAmount?: number;
}

interface HeliusNativeTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  amount?: number;
}

interface HeliusInstruction {
  programId?: string;
  innerInstructions?: unknown[];
}

interface HeliusTx {
  signature?: string;
  slot?: number;
  timestamp?: number;
  fee?: number;
  feePayer?: string;
  description?: string;
  type?: string;
  source?: string;
  transactionError?: unknown;
  instructions?: HeliusInstruction[];
  tokenTransfers?: HeliusTokenTransfer[];
  nativeTransfers?: HeliusNativeTransfer[];
  events?: unknown;
}

export const heliusTxDecoder: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  if (!heliusConfigured()) {
    return {
      status: 503,
      body: { error: "helius_not_configured" },
    };
  }

  let parsed: unknown;
  try {
    parsed = input.body && input.body.length > 0
      ? JSON.parse(input.body.toString("utf8"))
      : null;
  } catch {
    return {
      status: 400,
      body: { error: "invalid_json_body" },
    };
  }

  const signature =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)["signature"]
      : undefined;

  if (typeof signature !== "string" || signature.length === 0) {
    return {
      status: 400,
      body: { error: "signature_required" },
    };
  }

  // Basic shape check before burning a Helius credit. Solana signatures
  // are base58 strings of 86-88 chars; cheaper to reject here than to
  // round-trip a malformed value.
  if (signature.length < 64 || signature.length > 128) {
    return {
      status: 400,
      body: { error: "invalid_signature_format" },
    };
  }

  let response: Response;
  try {
    response = await heliusFetch(
      (apiKey) =>
        `https://api.helius.xyz/v0/transactions/?api-key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transactions: [signature] }),
      },
      { fetchImpl: input.fetchImpl },
    );
  } catch (err) {
    return heliusErrorToResult(err);
  }

  if (!response.ok) {
    return {
      status: 502,
      body: {
        error: "helius_api_error",
        upstreamStatus: response.status,
      },
    };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return {
      status: 502,
      body: { error: "helius_invalid_json" },
    };
  }

  const tx: HeliusTx | undefined = Array.isArray(data)
    ? (data[0] as HeliusTx | undefined)
    : (data as HeliusTx);

  if (!tx || tx.transactionError) {
    return {
      status: 404,
      body: { error: "transaction_not_found_or_failed" },
    };
  }

  return {
    status: 200,
    body: {
      signature: tx.signature ?? signature,
      slot: tx.slot ?? null,
      blockTime: tx.timestamp ?? null,
      fee: tx.fee ?? null,
      payer: tx.feePayer ?? null,
      type: tx.type ?? null,
      source: tx.source ?? null,
      // Helius's `description` is empty string (not null) for many
      // tx types it can't auto-summarise — fall through to `type` in
      // that case so the buyer always gets a non-empty summary field.
      summary:
        (tx.description && tx.description.length > 0 ? tx.description : null) ??
        tx.type ??
        "Unknown transaction",
      instructions: tx.instructions ?? [],
      tokenTransfers: tx.tokenTransfers ?? [],
      nativeTransfers: tx.nativeTransfers ?? [],
      events: tx.events ?? null,
    },
  };
};
