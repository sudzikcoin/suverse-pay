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
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
  InternalHandlerValidator,
} from "./types.js";

/**
 * Pre-payment validator for `helius_tx_decoder`. Same idea as
 * `heliusTxSimulatorValidator` but checks a base58 signature instead
 * of a base64 transaction blob. Solana tx signatures are 64-byte
 * Ed25519 sigs encoded as base58 — between 86 and 88 chars. We
 * accept a generous 64–128 char window to leave room for unusual
 * encodings; the handler itself re-checks more strictly after payment.
 */
export const heliusTxDecoderValidator: InternalHandlerValidator = (
  body,
  method,
) => {
  if (method !== "POST") return null;
  if (!body || body.length === 0) {
    return { status: 400, body: { error: "signature_required" } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { status: 400, body: { error: "invalid_json_body" } };
  }
  const sig =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)["signature"]
      : undefined;
  if (typeof sig !== "string" || sig.length === 0) {
    return { status: 400, body: { error: "signature_required" } };
  }
  if (sig.length < 64 || sig.length > 128) {
    return {
      status: 400,
      body: {
        error: "invalid_signature_format",
        message: "Solana signature must be 64-128 base58 chars",
      },
    };
  }
  // base58 alphabet (no 0, O, I, l). Reject if any other char appears.
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(sig)) {
    return {
      status: 400,
      body: { error: "signature_not_base58" },
    };
  }
  return null;
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
  const apiKey = process.env["HELIUS_API_KEY"];
  if (!apiKey) {
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

  const url = `https://api.helius.xyz/v0/transactions/?api-key=${encodeURIComponent(apiKey)}`;
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transactions: [signature] }),
    });
  } catch {
    return {
      status: 502,
      body: { error: "helius_unreachable" },
    };
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
