import {
  GatewayError,
  MerchantPolicySchema,
  PaymentPayloadSchema,
  PaymentRequirementsSchema,
} from "@suverse-pay/core-types";
import {
  resolvePolicy,
  route,
  runFallback,
  type RegisteredProvider,
} from "@suverse-pay/orchestrator";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerContext } from "../context.js";

const SettleBodySchema = z.object({
  paymentPayload: PaymentPayloadSchema,
  paymentRequirements: PaymentRequirementsSchema,
  policy: MerchantPolicySchema.partial().optional(),
});

/**
 * POST /settle
 *
 * The hot path. Requires Idempotency-Key (CLAUDE.md invariant 1).
 *
 * Flow:
 *   1. Resolve effective policy (default << per-api-key << per-request).
 *   2. createOrFetchPayment — two-layer idempotency (Redis SETNX +
 *      Postgres unique index). On replay (isNew=false), return the
 *      previously recorded response without re-broadcasting.
 *   3. Run router → record the decision in `routing_decisions`.
 *   4. Run fallback across the ordered candidate list, writing
 *      payment_attempts rows around every network call.
 *   5. Finalize the payments row with the outcome.
 *   6. Always release the Redis lock at the end of the request.
 */
export function registerSettleRoute(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  app.post("/settle", async (req) => {
    if (req.idempotencyKey === undefined) {
      throw new GatewayError(
        "invalid_request",
        400,
        "Idempotency-Key header is required for /settle",
      );
    }

    const body = SettleBodySchema.parse(req.body);
    const policy = resolvePolicy({
      requestPolicy: body.policy ?? null,
    });

    const initialRow = {
      network: body.paymentRequirements.network,
      asset: body.paymentRequirements.asset,
      amount: body.paymentRequirements.maxAmountRequired,
      recipient: body.paymentRequirements.payTo,
      ...(body.paymentRequirements.resource !== undefined
        ? { resource: body.paymentRequirements.resource }
        : {}),
      requestBody: body,
    };

    const { payment, isNew, lockKey } = await ctx.ledger.createOrFetchPayment({
      apiKeyId: req.apiKeyId,
      idempotencyKey: req.idempotencyKey,
      initialRow,
    });

    if (!isNew) {
      // Idempotent replay — return whatever we have on file.
      const attempts = await ctx.ledger.listAttempts(payment.paymentId);
      return serializePayment(payment, attempts);
    }

    try {
      const providers = ctx.registry.enabled();
      const summaries = await ctx.loadHealthSummaries(
        providers.map((p) => p.id),
      );
      const decision = await route({
        providers,
        context: {
          network: body.paymentRequirements.network,
          asset: body.paymentRequirements.asset,
          scheme: body.paymentRequirements.scheme,
          policy,
        },
        healthSummaries: summaries,
        now: ctx.now?.() ?? new Date(),
      });
      await ctx.ledger.recordRoutingDecision(payment.paymentId, decision);

      if (decision.candidates.length === 0 || decision.selected === null) {
        await ctx.ledger.finalizePayment(payment.paymentId, {
          status: "failed",
          errorCode: "route_unsupported",
          errorMessage: `no healthy provider supports the requested route`,
          settledAt: ctx.now?.() ?? new Date(),
        });
        const reread = await ctx.ledger.findById(payment.paymentId);
        const attempts = await ctx.ledger.listAttempts(payment.paymentId);
        return serializePayment(reread ?? payment, attempts);
      }

      const candidatesInOrder: RegisteredProvider[] = decision.candidates
        .map((c) => ctx.registry.getById(c.providerId))
        .filter((p): p is RegisteredProvider => p !== undefined);

      const fallback = await runFallback({
        paymentId: payment.paymentId,
        request: {
          paymentPayload: body.paymentPayload,
          paymentRequirements: body.paymentRequirements,
        },
        options: { idempotencyKey: req.idempotencyKey },
        policy,
        candidates: candidatesInOrder,
        ledger: ctx.ledger,
        ...(ctx.now !== undefined ? { now: ctx.now } : {}),
      });

      const final = fallback.finalResponse;
      if (final !== null && final.settled) {
        await ctx.ledger.finalizePayment(payment.paymentId, {
          status: "settled",
          finalProviderId: final.providerId,
          ...(final.txHash !== undefined ? { txHash: final.txHash } : {}),
          ...(final.payer !== undefined ? { payer: final.payer } : {}),
          settledAt: ctx.now?.() ?? new Date(),
        });
      } else {
        await ctx.ledger.finalizePayment(payment.paymentId, {
          status: "failed",
          ...(final?.providerId !== undefined
            ? { finalProviderId: final.providerId }
            : {}),
          ...(final?.errorCode !== undefined
            ? { errorCode: final.errorCode }
            : {}),
          ...(final?.errorMessage !== undefined
            ? { errorMessage: final.errorMessage }
            : {}),
          settledAt: ctx.now?.() ?? new Date(),
        });
      }

      const reread = (await ctx.ledger.findById(payment.paymentId)) ?? payment;
      const attempts = await ctx.ledger.listAttempts(payment.paymentId);
      return serializePayment(reread, attempts);
    } finally {
      if (lockKey !== null) {
        await ctx.ledger.releaseLock(lockKey);
      }
    }
  });
}

function serializePayment(
  payment: {
    paymentId: string;
    status: string;
    network: string;
    asset: string;
    amount: string;
    payer?: string;
    recipient: string;
    resource?: string;
    finalProviderId?: string;
    txHash?: string;
    errorCode?: string;
    errorMessage?: string;
    createdAt: Date;
    settledAt?: Date;
  },
  attempts: ReadonlyArray<{
    providerId: string;
    attemptNumber: number;
    outcome: string;
    errorCode?: string;
    errorMessage?: string;
    latencyMs: number;
    startedAt: Date;
    completedAt: Date;
    txHash?: string;
  }>,
): Record<string, unknown> {
  return {
    paymentId: payment.paymentId,
    status: payment.status,
    providerId: payment.finalProviderId ?? null,
    txHash: payment.txHash ?? null,
    network: payment.network,
    amount: payment.amount,
    asset: payment.asset,
    payer: payment.payer ?? null,
    recipient: payment.recipient,
    resource: payment.resource ?? null,
    errorCode: payment.errorCode ?? null,
    errorMessage: payment.errorMessage ?? null,
    createdAt: payment.createdAt.toISOString(),
    settledAt: payment.settledAt?.toISOString() ?? null,
    attempts: attempts.map((a) => ({
      providerId: a.providerId,
      attemptNumber: a.attemptNumber,
      outcome: a.outcome,
      errorCode: a.errorCode ?? null,
      errorMessage: a.errorMessage ?? null,
      latencyMs: a.latencyMs,
      startedAt: a.startedAt.toISOString(),
      completedAt: a.completedAt.toISOString(),
      txHash: a.txHash ?? null,
    })),
  };
}
