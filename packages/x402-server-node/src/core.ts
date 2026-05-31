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
import {
  facilitatorExtrasKey,
  getAllFacilitatorExtras,
  warmFacilitatorCache,
} from "./discover.js";

/**
 * Per-accept entry in the 402 challenge body. Matches the
 * `PaymentRequirementsV2Schema` in `@x402/core@2.14+`:
 * scheme, network (CAIP-2), asset, payTo, `amount` (NOT
 * `maxAmountRequired`), `maxTimeoutSeconds`, optional `extra`.
 */
export interface ChallengeAccept {
  readonly scheme: "exact";
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly amount: string;
  readonly maxTimeoutSeconds: number;
  readonly extra?: Record<string, unknown>;
}

/**
 * Top-level resource descriptor in the 402 challenge body. Mirrors
 * the `ResourceInfoSchema` in `@x402/core@2.14+`.
 */
export interface ChallengeResource {
  readonly url: string;
  readonly description?: string;
  readonly mimeType?: string;
}

/**
 * The 402 challenge body in Coinbase-flavour x402 v2 shape
 * (`@x402/core@2.14+`), which is what shipping ecosystem clients
 * (`@x402/fetch`, `@x402/express`, …) parse against. Setting
 * `opts.x402Version: 1` still tags the body with version 1 but
 * keeps the rest of the v2-superset shape; legacy v1-only clients
 * should look at the per-accept fields they care about.
 */
export interface ChallengeBody {
  readonly x402Version: 1 | 2;
  readonly resource: ChallengeResource;
  readonly accepts: ReadonlyArray<ChallengeAccept>;
  readonly error?: string;
  /**
   * Top-level discovery extensions forwarded verbatim from
   * `opts.extensions`. Ecosystem crawlers (Coinbase Bazaar) read
   * the bazaar block from the live 402.
   */
  readonly extensions?: Record<string, unknown>;
}

/** Default per-accept timeout when the seller didn't override it. */
const DEFAULT_MAX_TIMEOUT_SECONDS = 60;

/**
 * Constructs the 402 challenge body. Emits the Coinbase-flavour
 * x402 v2 shape so that ecosystem clients (`@x402/fetch` v2.14+)
 * parse it without a custom selector: top-level structured
 * `resource`, per-accept `amount` (not `maxAmountRequired`),
 * per-accept `maxTimeoutSeconds`, optional `extra`.
 *
 * As of v0.3.0 each accept's `extra` is the merge of two sources:
 *
 *   1. Facilitator-published per-kind extras, auto-fetched from
 *      `${opts.facilitator}/facilitator/supported` and cached in
 *      process (1 hour TTL by default). Surfaces things sellers
 *      don't own — Solana feePayer pubkey, Cosmos grantee address,
 *      EVM EIP-712 USDC domain — so sellers don't have to hardcode
 *      infrastructure data.
 *
 *   2. Seller-provided `extra` on the AcceptedPayment entry —
 *      overrides the facilitator's value per key. Old (pre-v0.3.0)
 *      configs with hardcoded extras keep working unchanged.
 *
 * Set `opts.disableAutoDiscover: true` to skip step 1 entirely; the
 * v0.2.0 "seller-only extras" behavior comes back.
 */
export async function buildChallenge(
  opts: MiddlewareOptions,
  resourceUrl: string,
  errorHint?: string,
): Promise<ChallengeBody> {
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
  const extrasByKind = opts.disableAutoDiscover === true
    ? null
    : await getAllFacilitatorExtras(opts.facilitator, {
        ...(opts.facilitatorExtrasCacheTtlMs !== undefined
          ? { ttlMs: opts.facilitatorExtrasCacheTtlMs }
          : {}),
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      });
  return {
    x402Version: opts.x402Version ?? 2,
    resource: {
      url: resourceUrl,
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      mimeType: "application/json",
    },
    accepts: opts.acceptedPayments.map((p): ChallengeAccept => {
      const merged = mergeExtras(
        extrasByKind?.get(facilitatorExtrasKey(p.network, p.scheme)),
        p.extra,
      );
      return {
        scheme: p.scheme,
        network: p.network,
        asset: p.asset,
        payTo: p.payTo,
        amount: p.maxAmountRequired,
        maxTimeoutSeconds: DEFAULT_MAX_TIMEOUT_SECONDS,
        ...(merged !== undefined ? { extra: merged } : {}),
      };
    }),
    ...(errorHint !== undefined ? { error: errorHint } : {}),
    ...(opts.extensions !== undefined ? { extensions: opts.extensions } : {}),
  };
}

/**
 * Merge precedence: seller wins per key. Returns `undefined` only
 * when both inputs are absent so `extra` can be omitted from the
 * challenge entirely (instead of emitting `extra: {}` noise).
 */
function mergeExtras(
  facilitator: Record<string, unknown> | undefined,
  seller: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (facilitator === undefined && seller === undefined) return undefined;
  if (facilitator === undefined) return seller;
  if (seller === undefined) return facilitator;
  return { ...facilitator, ...seller };
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
  // x402 v2 ecosystem clients (`@x402/fetch` v2.14+) nest scheme/network
  // inside an `accepted` object (PaymentPayloadV2Schema). v1 clients
  // (`x402-fetch` v1.x) put them at the top level. Read both.
  const acc =
    obj["accepted"] && typeof obj["accepted"] === "object" && !Array.isArray(obj["accepted"])
      ? (obj["accepted"] as Record<string, unknown>)
      : null;
  const scheme = (acc && typeof acc["scheme"] === "string" ? acc["scheme"] : undefined)
    ?? obj["scheme"];
  const network = (acc && typeof acc["network"] === "string" ? acc["network"] : undefined)
    ?? obj["network"];
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
 * Resolve the `extra` to send to the facilitator on /verify and
 * /settle for the matched requirement. Mirrors `buildChallenge`'s
 * merge semantics: facilitator-published extras are the base,
 * seller-provided extras override per key. The two surfaces MUST
 * agree — the buyer signed against the merged value emitted in the
 * 402 challenge, so verify/settle must see the same value or the
 * facilitator will reject the payload (`missing extra.feePayer`,
 * `missing extra.facilitator`, etc.).
 *
 * Returns `undefined` when no extras flow from either source so the
 * caller can omit `extra` from the body cleanly.
 */
async function resolveRequirementExtra(
  opts: MiddlewareOptions,
  requirement: AcceptedPayment,
): Promise<Record<string, unknown> | undefined> {
  const facilitatorExtras = opts.disableAutoDiscover === true
    ? undefined
    : await getAllFacilitatorExtras(opts.facilitator, {
        ...(opts.facilitatorExtrasCacheTtlMs !== undefined
          ? { ttlMs: opts.facilitatorExtrasCacheTtlMs }
          : {}),
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      }).then((m) => m.get(facilitatorExtrasKey(requirement.network, requirement.scheme)));
  if (facilitatorExtras === undefined && requirement.extra === undefined) {
    return undefined;
  }
  if (facilitatorExtras === undefined) return requirement.extra;
  if (requirement.extra === undefined) return facilitatorExtras;
  return { ...facilitatorExtras, ...requirement.extra };
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
  resourceUrl: string,
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
  // facilitator.suverse.io currently validates against an x402 v1-flat
  // shape (top-level scheme/network/payload on paymentPayload; v1 fields
  // — maxAmountRequired, resource string, description, mimeType,
  // maxTimeoutSeconds — on paymentRequirements). v2 ecosystem clients
  // emit the v2-nested shape (`accepted.scheme`, `accepted.network`),
  // so flatten here. Keep the original v2 `accepted`/`resource` fields
  // alongside so a future v2-native facilitator can read either form.
  const rawObj =
    decoded.raw && typeof decoded.raw === "object"
      ? (decoded.raw as Record<string, unknown>)
      : {};
  const flatPaymentPayload: Record<string, unknown> = {
    x402Version: decoded.x402Version,
    scheme: decoded.scheme,
    network: decoded.network,
    payload: decoded.payload,
  };
  if (rawObj["accepted"] !== undefined) flatPaymentPayload["accepted"] = rawObj["accepted"];
  if (rawObj["resource"] !== undefined) flatPaymentPayload["resource"] = rawObj["resource"];
  // Discovery extensions (e.g. bazaar) — the seller's challenge advertised
  // them via `opts.extensions`, but the buyer's signed payload only echoes
  // back `accepted`. Re-inject them on the outbound /verify and /settle
  // envelope so downstream facilitators that index by payload extensions
  // (Coinbase CDP's bazaar crawler) see them. Buyer signature covers only
  // the inner `payload.authorization`, so adding outer fields is safe.
  if (opts.extensions !== undefined) {
    flatPaymentPayload["extensions"] = opts.extensions;
  }
  // Merge facilitator-published + seller-provided extras the same
  // way buildChallenge did when emitting the 402. Without this, the
  // buyer's signature (which the buyer constructed against the merged
  // 402 extras) gets verified against an incomplete `extra` here and
  // the facilitator/adapter rejects with e.g. `missing extra.feePayer`.
  const mergedExtra = await resolveRequirementExtra(opts, requirement);
  const body = JSON.stringify({
    paymentPayload: flatPaymentPayload,
    paymentRequirements: {
      scheme: requirement.scheme,
      network: requirement.network,
      asset: requirement.asset,
      payTo: requirement.payTo,
      maxAmountRequired: requirement.maxAmountRequired,
      resource: resourceUrl,
      description: opts.description ?? "",
      mimeType: "application/json",
      maxTimeoutSeconds: DEFAULT_MAX_TIMEOUT_SECONDS,
      ...(mergedExtra !== undefined ? { extra: mergedExtra } : {}),
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
      body: await buildChallenge(opts, resourceUrl),
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
        body: await buildChallenge(opts, resourceUrl, err.message),
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
      body: await buildChallenge(
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
      resourceUrl,
    );
  } catch (err) {
    if (err instanceof X402Error) {
      return {
        kind: "rejected",
        status: err.statusCode >= 500 ? 502 : 402,
        body: await buildChallenge(opts, resourceUrl, err.message),
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
      body: await buildChallenge(opts, resourceUrl, reason),
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
      resourceUrl,
    );
  } catch (err) {
    if (err instanceof X402Error) {
      return {
        kind: "rejected",
        status: err.statusCode >= 500 ? 502 : 402,
        body: await buildChallenge(opts, resourceUrl, err.message),
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
      body: await buildChallenge(opts, resourceUrl, reason),
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
  // Fire-and-forget warm of the facilitator /supported cache so the
  // first real 402 doesn't pay the fetch latency. Failure is logged
  // by `discover.ts` and never propagates here — `buildChallenge`
  // gracefully degrades to seller-only extras if the warm errored.
  if (opts.disableAutoDiscover !== true) {
    warmFacilitatorCache(opts.facilitator, {
      ...(opts.facilitatorExtrasCacheTtlMs !== undefined
        ? { ttlMs: opts.facilitatorExtrasCacheTtlMs }
        : {}),
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    });
  }
}
