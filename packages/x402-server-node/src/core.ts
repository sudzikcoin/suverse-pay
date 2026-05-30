/**
 * Framework-agnostic core of the middleware.
 *
 * Both the Express and Fastify adapters are thin wrappers around the
 * functions in this file. Keeping the HTTP-specific bits at the edge
 * lets us unit-test the protocol logic without spinning up a server.
 */

import { randomUUID } from "node:crypto";
import type {
  AcceptedPayment,
  MiddlewareOptions,
  PaymentReceipt,
} from "./types.js";
import { X402Error } from "./types.js";

/**
 * The exact x402 v2 challenge body. Field names track the spec so
 * a wire dump is grep-able. The middleware also supports v1 clients
 * by toggling the version number — the rest of the shape is the
 * same superset both versions accept.
 */
export interface ChallengeBody {
  readonly x402Version: 1 | 2;
  readonly accepts: ReadonlyArray<AcceptedPayment & { resource: string }>;
  readonly error?: string;
  readonly description?: string;
}

/**
 * Constructs the 402 challenge body. Inlines `resource` (the URL
 * that triggered the 402) per spec so the client doesn't have to
 * re-derive it.
 */
export function buildChallenge(
  opts: MiddlewareOptions,
  resourceUrl: string,
  errorHint?: string,
): ChallengeBody {
  if (opts.acceptedPayments.length === 0) {
    // This is a configuration bug (caught at createX402Middleware
    // time, but be defensive). A 402 with no payment options is
    // unfulfillable.
    throw new X402Error(
      "no_accepted_payments",
      500,
      "x402-server: acceptedPayments is empty; configure at least one",
    );
  }
  return {
    x402Version: opts.x402Version ?? 2,
    accepts: opts.acceptedPayments.map((p) => ({ ...p, resource: resourceUrl })),
    ...(errorHint !== undefined ? { error: errorHint } : {}),
    ...(opts.description !== undefined
      ? { description: opts.description }
      : {}),
  };
}

/**
 * Decodes the `X-Payment` request header. Per x402 v2 the header is
 * a base64-encoded JSON object whose top-level shape is
 * `{ x402Version, scheme, network, payload }`. We do NOT validate
 * the inner `payload` — that's the facilitator's job — but we do
 * extract enough to match the call against one of our declared
 * `acceptedPayments` entries.
 */
export interface DecodedPaymentHeader {
  readonly x402Version: number;
  readonly scheme: string;
  readonly network: string;
  readonly payload: unknown;
  /** The raw decoded JSON object (for forwarding to /verify). */
  readonly raw: Record<string, unknown>;
}

export function decodePaymentHeader(headerValue: string): DecodedPaymentHeader {
  let json: string;
  try {
    json = Buffer.from(headerValue.trim(), "base64").toString("utf8");
  } catch (err) {
    throw new X402Error(
      "invalid_payment_header",
      400,
      `X-Payment header is not valid base64: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new X402Error(
      "invalid_payment_header",
      400,
      `X-Payment header is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new X402Error(
      "invalid_payment_header",
      400,
      "X-Payment header must decode to a JSON object",
    );
  }
  const obj = parsed as Record<string, unknown>;
  const version = obj["x402Version"];
  const scheme = obj["scheme"];
  const network = obj["network"];
  if (typeof version !== "number") {
    throw new X402Error(
      "invalid_payment_header",
      400,
      "X-Payment payload missing numeric x402Version",
    );
  }
  if (typeof scheme !== "string" || typeof network !== "string") {
    throw new X402Error(
      "invalid_payment_header",
      400,
      "X-Payment payload missing scheme/network strings",
    );
  }
  return {
    x402Version: version,
    scheme,
    network,
    payload: obj["payload"],
    raw: obj,
  };
}

/**
 * Find the seller's `acceptedPayments` row that matches the decoded
 * header's (scheme, network). If none matches, the client paid for
 * something we don't accept — return 402 with the standard
 * challenge so they can retry against a supported requirement.
 */
export function matchRequirement(
  decoded: DecodedPaymentHeader,
  accepted: readonly AcceptedPayment[],
): AcceptedPayment | undefined {
  return accepted.find(
    (a) => a.scheme === decoded.scheme && a.network === decoded.network,
  );
}

/** Strip a trailing slash to keep `${base}/facilitator/...` clean. */
function normaliseBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Calls the facilitator's verify or settle endpoint with the
 * standard x402 v2 envelope. Both endpoints take the same body
 * shape per spec § 5.3 / 5.4: `{ paymentPayload, paymentRequirements }`.
 *
 * Settle additionally requires the seller's resource API key on
 * the Authorization header — facilitators reject anonymous settles.
 */
async function callFacilitator(
  opts: MiddlewareOptions,
  endpoint: "verify" | "settle",
  decoded: DecodedPaymentHeader,
  requirement: AcceptedPayment,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  const baseUrl = normaliseBaseUrl(opts.facilitator);
  const url = `${baseUrl}/facilitator/${endpoint}`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (endpoint === "settle") {
    // The facilitator's /verify route is open per spec, only /settle
    // requires the resource key. Forward unconditionally if it's
    // configured though — facilitators are free to require it on
    // /verify too, and it's harmless if they ignore it.
    headers["Authorization"] = `Bearer ${opts.apiKey}`;
    headers["Idempotency-Key"] = idempotencyKey;
  }
  const body = JSON.stringify({
    paymentPayload: decoded.raw,
    paymentRequirements: {
      scheme: requirement.scheme,
      network: requirement.network,
      asset: requirement.asset,
      payTo: requirement.payTo,
      maxAmountRequired: requirement.maxAmountRequired,
    },
  });
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body,
      // 30s — verify is sub-second, settle waits for a chain
      // confirmation which on Base is ~2s + facilitator overhead.
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new X402Error(
      "facilitator_unreachable",
      502,
      `facilitator ${endpoint} call failed: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    throw new X402Error(
      "facilitator_bad_response",
      502,
      `facilitator ${endpoint} returned non-JSON: ${(err as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new X402Error(
      "facilitator_bad_response",
      502,
      `facilitator ${endpoint} returned non-object body`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  if (!response.ok) {
    // Forward the facilitator's own error code+message so the
    // client (or human reading logs) can act on it.
    const code =
      typeof obj["errorCode"] === "string"
        ? (obj["errorCode"] as string)
        : "facilitator_error";
    const msg =
      typeof obj["errorMessage"] === "string"
        ? (obj["errorMessage"] as string)
        : `facilitator ${endpoint} returned HTTP ${response.status}`;
    throw new X402Error(code, response.status, msg);
  }
  return obj;
}

/**
 * Result of running the protocol exchange for one incoming request.
 *
 * - `kind === "challenge"`: no X-Payment present; the middleware
 *   should respond 402 with `body`.
 * - `kind === "rejected"`: the X-Payment was parsed but failed
 *   verify or settle; the middleware should respond with the given
 *   status code and challenge body so the client can retry.
 * - `kind === "accepted"`: success — attach `receipt` to the
 *   request and invoke the seller's handler.
 */
export type ProtocolResult =
  | { kind: "challenge"; status: 402; body: ChallengeBody }
  | {
      kind: "rejected";
      status: 402 | 400 | 502;
      body: ChallengeBody;
      reason: string;
    }
  | { kind: "accepted"; receipt: PaymentReceipt };

/**
 * Run the full protocol exchange. This is what both framework
 * adapters call once per request.
 */
export async function runProtocol(args: {
  opts: MiddlewareOptions;
  resourceUrl: string;
  paymentHeader: string | undefined;
  idempotencyKey: string | undefined;
}): Promise<ProtocolResult> {
  const { opts, resourceUrl, paymentHeader } = args;

  // No header → challenge.
  if (!paymentHeader || paymentHeader.trim() === "") {
    return {
      kind: "challenge",
      status: 402,
      body: buildChallenge(opts, resourceUrl),
    };
  }

  let decoded: DecodedPaymentHeader;
  try {
    decoded = decodePaymentHeader(paymentHeader);
  } catch (err) {
    if (err instanceof X402Error) {
      return {
        kind: "rejected",
        status: 400,
        body: buildChallenge(opts, resourceUrl, err.message),
        reason: err.message,
      };
    }
    throw err;
  }

  const requirement = matchRequirement(decoded, opts.acceptedPayments);
  if (!requirement) {
    return {
      kind: "rejected",
      status: 402,
      body: buildChallenge(
        opts,
        resourceUrl,
        `no matching requirement for scheme=${decoded.scheme} network=${decoded.network}`,
      ),
      reason: "no_matching_requirement",
    };
  }

  const idempotencyKey = args.idempotencyKey ?? randomUUID();

  // verify first. Settle is gated behind a successful verify so the
  // client gets a fast "your signature is bad" response without us
  // paying for an on-chain attempt.
  let verifyResult: Record<string, unknown>;
  try {
    verifyResult = await callFacilitator(
      opts,
      "verify",
      decoded,
      requirement,
      idempotencyKey,
    );
  } catch (err) {
    if (err instanceof X402Error) {
      return {
        kind: "rejected",
        status: err.statusCode >= 500 ? 502 : 402,
        body: buildChallenge(opts, resourceUrl, err.message),
        reason: err.code,
      };
    }
    throw err;
  }
  const isValid = verifyResult["isValid"];
  if (isValid !== true) {
    const reason =
      typeof verifyResult["invalidReason"] === "string"
        ? (verifyResult["invalidReason"] as string)
        : "verify_failed";
    return {
      kind: "rejected",
      status: 402,
      body: buildChallenge(opts, resourceUrl, reason),
      reason,
    };
  }
  const payer =
    typeof verifyResult["payer"] === "string"
      ? (verifyResult["payer"] as string)
      : "";

  // verify-only mode short-circuits here.
  if (opts.settle === false) {
    return {
      kind: "accepted",
      receipt: {
        payer,
        network: requirement.network,
        asset: requirement.asset,
        amount: requirement.maxAmountRequired,
        txHash: null,
        raw: verifyResult,
      },
    };
  }

  let settleResult: Record<string, unknown>;
  try {
    settleResult = await callFacilitator(
      opts,
      "settle",
      decoded,
      requirement,
      idempotencyKey,
    );
  } catch (err) {
    if (err instanceof X402Error) {
      return {
        kind: "rejected",
        status: err.statusCode >= 500 ? 502 : 402,
        body: buildChallenge(opts, resourceUrl, err.message),
        reason: err.code,
      };
    }
    throw err;
  }
  const success = settleResult["success"];
  if (success !== true) {
    const reason =
      typeof settleResult["errorReason"] === "string"
        ? (settleResult["errorReason"] as string)
        : "settle_failed";
    return {
      kind: "rejected",
      status: 402,
      body: buildChallenge(opts, resourceUrl, reason),
      reason,
    };
  }
  const txHash =
    typeof settleResult["transaction"] === "string"
      ? (settleResult["transaction"] as string)
      : typeof settleResult["txHash"] === "string"
        ? (settleResult["txHash"] as string)
        : null;

  return {
    kind: "accepted",
    receipt: {
      payer:
        typeof settleResult["payer"] === "string"
          ? (settleResult["payer"] as string)
          : payer,
      network: requirement.network,
      asset: requirement.asset,
      amount: requirement.maxAmountRequired,
      txHash,
      raw: settleResult,
    },
  };
}

/**
 * Validation run by both framework adapter constructors. Catching
 * misconfiguration at boot is cheaper than catching it on the first
 * 402.
 */
export function validateOptions(opts: MiddlewareOptions): void {
  if (typeof opts.apiKey !== "string" || opts.apiKey.length === 0) {
    throw new X402Error(
      "missing_api_key",
      500,
      "x402-server: opts.apiKey is required",
    );
  }
  if (typeof opts.facilitator !== "string" || opts.facilitator.length === 0) {
    throw new X402Error(
      "missing_facilitator",
      500,
      "x402-server: opts.facilitator is required",
    );
  }
  if (!opts.acceptedPayments || opts.acceptedPayments.length === 0) {
    throw new X402Error(
      "no_accepted_payments",
      500,
      "x402-server: opts.acceptedPayments must contain at least one entry",
    );
  }
  for (const p of opts.acceptedPayments) {
    if (
      typeof p.network !== "string" ||
      typeof p.asset !== "string" ||
      typeof p.payTo !== "string" ||
      typeof p.maxAmountRequired !== "string"
    ) {
      throw new X402Error(
        "invalid_accepted_payment",
        500,
        `x402-server: acceptedPayments entry missing required string fields (network/asset/payTo/maxAmountRequired)`,
      );
    }
  }
}
