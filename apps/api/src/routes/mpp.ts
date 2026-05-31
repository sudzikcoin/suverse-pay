import {
  challengeFromHeaderLine,
  challengeToHeaderLine,
  credentialFromHeaderLine,
  type MppChallenge,
  type MppFacilitatorAdapter,
} from "@suverse-pay/adapter-mpp";
import { GatewayError } from "@suverse-pay/core-types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ServerContext } from "../context.js";

/**
 * Body of POST /mpp/charge. The same body shape is used on both the
 * 402-challenge call (no Authorization header) and the retry call
 * (with Authorization: Payment header); the request body parameters
 * deterministically derive the MPP challenge.
 */
const MppChargeBodySchema = z.object({
  /** Atomic-unit amount as decimal-integer string. */
  amount: z.string().regex(/^[1-9]\d*$/u),
  /** ERC-20 contract address on the target chain (or "USD" for the future stripe method). */
  currency: z.string().min(1),
  /** Address to receive the transfer. */
  recipient: z.string().min(1),
  /** Target chain id (numeric). v1: 42431 (Tempo Moderato testnet). */
  chainId: z.number().int().positive(),
  /** Optional human-readable summary; echoed into the challenge. */
  description: z.string().max(1024).optional(),
});

type MppChargeBody = z.infer<typeof MppChargeBodySchema>;

/**
 * Build the canonical challenge for a given (Idempotency-Key, body)
 * pair. The same inputs always produce the same challenge — there is
 * no server-side challenge store. The Idempotency-Key doubles as the
 * binding token: clients send it on both the 402 + retry calls so
 * the credential.challengeId field re-derives to the same value.
 */
function buildChallenge(args: {
  idempotencyKey: string;
  body: MppChargeBody;
  realm: string;
}): MppChallenge {
  const requestPayload: Record<string, unknown> = {
    amount: args.body.amount,
    currency: args.body.currency,
    recipient: args.body.recipient,
    chainId: args.body.chainId,
  };
  if (args.body.description !== undefined) {
    requestPayload["description"] = args.body.description;
  }
  return {
    id: args.idempotencyKey,
    realm: args.realm,
    method: "tempo",
    intent: "charge",
    request: requestPayload,
  };
}

/**
 * Header name for the MPP credential. The MPP spec puts it on
 * `Authorization: Payment ...`, but our gateway already consumes
 * `Authorization: Bearer <api_key>` for tenant auth — the two can't
 * cohabit on the same request. v1 reads the credential from
 * `Payment-Authorization` instead, keeping the spec verb ("Payment")
 * but moving off the collision. Future hardening can also accept
 * `Authorization: Payment ...` when the Bearer is supplied via a
 * separate `X-Suverse-Api-Key` header; out of scope for Phase 2 v1.
 */
const PAYMENT_AUTH_HEADER = "payment-authorization";

/**
 * Extract `Payment <token>` from the request's Payment-Authorization
 * header. Returns null when the header is absent or not an MPP
 * credential.
 */
function extractMppAuthorizationHeader(req: FastifyRequest): string | null {
  const raw = req.headers[PAYMENT_AUTH_HEADER];
  if (typeof raw !== "string") return null;
  if (!raw.trim().toLowerCase().startsWith("payment ")) return null;
  return raw;
}

function caip2(chainId: number): `eip155:${number}` {
  return `eip155:${chainId}` as const;
}

const ALLOWED_PUBLIC_PATHS = new Set<string>(["/mpp/charge"]);

/**
 * POST /mpp/charge — the Phase 2 v1 entry point for MPP-flow payments.
 *
 * Stateless challenge: the (Idempotency-Key, body) pair deterministically
 * derives the challenge. Clients send the same Idempotency-Key + body
 * on both the initial 402 call and the retry with credential.
 *
 * Flow:
 *   1. First call (no `Authorization: Payment ...`): build the challenge
 *      from the body + Idempotency-Key, emit 402 with the
 *      `WWW-Authenticate: Payment ...` header. No payments row is
 *      written; the client is expected to broadcast the transfer and
 *      come back.
 *   2. Retry (with `Authorization: Payment <token>`): re-derive the
 *      challenge identically, parse the credential, hand both to the
 *      MPP adapter for verify + settle. On success, persist a
 *      payments row (protocol="mpp", mppMethod="tempo",
 *      mppIntent="charge") via PaymentLedger.createOrFetchPayment;
 *      the same Idempotency-Key protects against double-settle.
 *
 * Requires `Authorization: Bearer <api_key>` (gateway-level auth,
 * registered globally in server.ts). Idempotency-Key is mandatory.
 */
export function registerMppRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  app.post("/mpp/charge", async (req, reply) => {
    const mppAdapter = ctx.mppAdapter;
    if (mppAdapter === undefined) {
      throw new GatewayError(
        "temporary_unavailable",
        503,
        "MPP adapter is not configured; set STRIPE_MPP_ENABLED=true to enable POST /mpp/charge.",
      );
    }

    if (req.idempotencyKey === undefined) {
      throw new GatewayError(
        "invalid_request",
        400,
        "Idempotency-Key header is required for POST /mpp/charge — it binds the 402 challenge to the retry credential.",
      );
    }

    const body = MppChargeBodySchema.parse(req.body);
    const realm = typeof req.headers.host === "string" ? req.headers.host : "api.suverse.io";
    const challenge = buildChallenge({
      idempotencyKey: req.idempotencyKey,
      body,
      realm,
    });

    const authHeader = extractMppAuthorizationHeader(req);
    if (authHeader === null) {
      return emit402Challenge(reply, challenge);
    }

    return handleRetryWithCredential(req, reply, {
      ctx,
      mppAdapter,
      body,
      challenge,
      authHeader,
    });
  });
  // Mark the path public against future request-path allowlists; the
  // route itself is still Bearer-auth-protected by registerAuth.
  void ALLOWED_PUBLIC_PATHS;
}

/**
 * Initial call — emit 402 + `WWW-Authenticate: Payment ...`. Body
 * carries the JSON challenge for clients that prefer to read it
 * structured rather than parsing the header.
 */
function emit402Challenge(reply: FastifyReply, challenge: MppChallenge): FastifyReply {
  reply
    .code(402)
    .header("WWW-Authenticate", challengeToHeaderLine(challenge))
    .header("Access-Control-Expose-Headers", "WWW-Authenticate");
  return reply.send({
    error: "payment_required",
    challenge,
  });
}

/**
 * Retry call — parse the credential, dispatch verify+settle through
 * the adapter, persist the payments row on success.
 */
async function handleRetryWithCredential(
  req: FastifyRequest,
  reply: FastifyReply,
  ctxArgs: {
    ctx: ServerContext;
    mppAdapter: MppFacilitatorAdapter;
    body: MppChargeBody;
    challenge: MppChallenge;
    authHeader: string;
  },
): Promise<unknown> {
  let credential;
  try {
    credential = credentialFromHeaderLine(ctxArgs.authHeader);
  } catch (err) {
    throw new GatewayError(
      "invalid_request",
      400,
      `Malformed MPP credential in Authorization header: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (credential.challengeId !== ctxArgs.challenge.id) {
    throw new GatewayError(
      "invalid_request",
      400,
      `MPP credential.challengeId (${credential.challengeId}) does not match the request's Idempotency-Key — both must match for the verify path to bind to a stable challenge.`,
    );
  }

  const verifyResult = await ctxArgs.mppAdapter.verifyCredential({
    challenge: ctxArgs.challenge,
    credential,
  });
  if (!verifyResult.valid) {
    reply.code(422);
    return {
      error: verifyResult.errorCode ?? "verify_failed",
      message: verifyResult.errorMessage ?? "MPP credential verification failed.",
      challenge: ctxArgs.challenge,
    };
  }

  const settleResult = await ctxArgs.mppAdapter.settleCredential({
    challenge: ctxArgs.challenge,
    credential,
    idempotencyKey: req.idempotencyKey,
  });
  if (!settleResult.settled) {
    reply.code(422);
    return {
      error: settleResult.errorCode ?? "settle_failed",
      message: settleResult.errorMessage ?? "MPP settle failed.",
      challenge: ctxArgs.challenge,
    };
  }

  // Persist the payments row. createOrFetchPayment is idempotent on
  // (apiKeyId, idempotencyKey) — duplicate retries with the same key
  // collapse to a single row.
  const initialRow = {
    network: caip2(ctxArgs.body.chainId),
    asset: ctxArgs.body.currency,
    amount: ctxArgs.body.amount,
    recipient: ctxArgs.body.recipient,
    requestBody: ctxArgs.body,
    protocol: "mpp" as const,
    mppMethod: credential.method,
    mppIntent: credential.intent,
  };
  const { payment, isNew, lockKey } = await ctxArgs.ctx.ledger.createOrFetchPayment({
    apiKeyId: req.apiKeyId,
    idempotencyKey: req.idempotencyKey,
    initialRow,
  });

  if (isNew) {
    try {
      await ctxArgs.ctx.ledger.finalizePayment(payment.paymentId, {
        status: "settled",
        ...(settleResult.reference !== undefined ? { txHash: settleResult.reference } : {}),
        ...(verifyResult.payer !== undefined ? { payer: verifyResult.payer } : {}),
        settledAt: new Date(),
      });
    } finally {
      if (lockKey !== null) await ctxArgs.ctx.ledger.releaseLock(lockKey);
    }
  }

  reply.header(
    "Payment-Response",
    JSON.stringify({
      protocol: "mpp",
      reference: settleResult.reference ?? null,
      network: settleResult.network ?? caip2(ctxArgs.body.chainId),
      asset: settleResult.asset ?? ctxArgs.body.currency,
      amount: settleResult.amount ?? ctxArgs.body.amount,
      settledAt: settleResult.settledAt,
    }),
  );
  reply.header("Access-Control-Expose-Headers", "Payment-Response");

  return {
    ok: true,
    paymentId: payment.paymentId,
    reference: settleResult.reference,
    network: settleResult.network ?? caip2(ctxArgs.body.chainId),
    asset: settleResult.asset ?? ctxArgs.body.currency,
    amount: settleResult.amount ?? ctxArgs.body.amount,
    payer: verifyResult.payer,
    settledAt: settleResult.settledAt,
    replayed: !isNew,
  };
}
