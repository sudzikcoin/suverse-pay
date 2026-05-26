import { GatewayError } from "@suverse-pay/core-types";
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../context.js";

/**
 * GET /payments/:id
 *
 * Looks up a payment by id. Restricted to the caller's api_key — a
 * client cannot read another tenant's payment even if it guesses an
 * id. Returns the same shape as the `/settle` response.
 */
export function registerPaymentsRoute(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  app.get<{ Params: { id: string } }>(
    "/payments/:id",
    async (req) => {
      const payment = await ctx.ledger.findById(req.params.id);
      if (payment === null || payment.apiKeyId !== req.apiKeyId) {
        // Identical response for "not found" vs "not yours" so the
        // tenant cannot probe for existence.
        throw new GatewayError("not_found", 404, "payment not found");
      }
      const attempts = await ctx.ledger.listAttempts(payment.paymentId);
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
    },
  );
}
