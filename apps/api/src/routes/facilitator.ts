import {
  GatewayError,
  PaymentPayloadSchema,
  PaymentRequirementsSchema,
} from "@suverse-pay/core-types";
import {
  buildSupportedResponse,
  createOrFetchFacilitatorPayment,
  deriveFacilitatorIdempotencyKey,
  extractPayerAddress,
  extractPayloadNonce,
  finalizeFacilitatorPayment,
  isRouteSupported,
  recordFailoverEvent,
  routeSettleWithFailover,
  routeVerify,
} from "@suverse-pay/facilitator";
import { enqueueSettleEvent } from "@suverse-pay/webhooks";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { facilitatorRateLimitHitsTotal } from "../lib/metrics.js";
import { requireResourceKey } from "../plugins/resource-key-auth.js";

const FacilitatorRequestSchema = z.object({
  x402Version: z.number().int().positive().optional(),
  paymentPayload: PaymentPayloadSchema,
  paymentRequirements: PaymentRequirementsSchema,
});

/**
 * Register the public /facilitator/* endpoints.
 *
 * Auth model:
 *   GET  /facilitator/supported  — open access (no auth)
 *   GET  /facilitator/health     — open access (no auth)
 *   POST /facilitator/verify     — open access (no auth; verify is read-only)
 *   POST /facilitator/settle     — resource API key required
 *
 * The server-wide admin-auth `onRequest` hook in plugins/auth.ts
 * explicitly skips this prefix; route-level `requireResourceKey`
 * runs only on /facilitator/settle.
 */
export function registerFacilitatorRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  // ---- GET /facilitator/supported -----------------------------------
  app.get("/facilitator/supported", async () => {
    // ctx.pool may be absent in lightweight dev/test bootstraps —
    // buildSupportedResponse falls back to the kinds-only shape when
    // omitted (same as pre-PR-A behavior). In production apps/api
    // always constructs a pool.
    return buildSupportedResponse(ctx.registry, ctx.pool);
  });

  // ---- GET /facilitator/health --------------------------------------
  app.get("/facilitator/health", async () => {
    return { status: "ok", x402Version: 2 };
  });

  // ---- POST /facilitator/verify (open) ------------------------------
  app.post("/facilitator/verify", async (req) => {
    const body = FacilitatorRequestSchema.parse(req.body);
    if (
      !isRouteSupported(
        ctx.registry,
        body.paymentRequirements.network,
        body.paymentRequirements.scheme,
      )
    ) {
      throw new GatewayError(
        "route_unsupported",
        400,
        `no facilitator available for (${body.paymentRequirements.network}, ${body.paymentRequirements.scheme})`,
      );
    }
    const { response } = await routeVerify(ctx.registry, {
      paymentPayload: body.paymentPayload,
      paymentRequirements: body.paymentRequirements,
    });
    // The x402 v2 facilitator spec (§5.4) defines VerifyResponse with
    // isValid + payer + invalidReason. Our adapter contract uses
    // `valid` / `errorCode` / `errorMessage`; translate to spec shape.
    if (response.valid) {
      const out: Record<string, unknown> = { isValid: true };
      if (response.payer !== undefined) out.payer = response.payer;
      return out;
    }
    const out: Record<string, unknown> = { isValid: false };
    if (response.errorCode !== undefined) out.invalidReason = response.errorCode;
    if (response.payer !== undefined) out.payer = response.payer;
    return out;
  });

  // ---- POST /facilitator/settle (resource API key required) ---------
  if (ctx.pool === undefined || ctx.facilitatorRateLimiter === undefined) {
    // Tests / dev setups without pool+rate-limiter skip /settle
    // registration entirely. Production index.ts always supplies both.
    return;
  }
  const pool = ctx.pool;
  const rateLimiter = ctx.facilitatorRateLimiter;

  app.post(
    "/facilitator/settle",
    { preHandler: requireResourceKey(pool) },
    async (req) => {
      const resourceKey = req.resourceKey!;
      // Rate limit BEFORE any work.
      const rl = await rateLimiter.check({
        resourceKeyId: resourceKey.id,
        perMinuteLimit: resourceKey.rateLimitPerMinute,
      });
      if (!rl.allowed) {
        facilitatorRateLimitHitsTotal
          .labels({ resource_key_label: resourceKey.label })
          .inc();
        throw new GatewayError(
          "rate_limited",
          429,
          `rate limit ${rl.used}/${rl.limit} requests-per-minute exceeded for resource key ${resourceKey.id}; retry after ${rl.retryAfterSeconds}s`,
          { retryAfterSeconds: rl.retryAfterSeconds },
        );
      }
      const body = FacilitatorRequestSchema.parse(req.body);
      const network = body.paymentRequirements.network;
      const scheme = body.paymentRequirements.scheme;
      if (!isRouteSupported(ctx.registry, network, scheme)) {
        throw new GatewayError(
          "route_unsupported",
          400,
          `no facilitator available for (${network}, ${scheme})`,
        );
      }
      // Derive a deterministic idempotency key from (resourceKey,
      // payer, payloadNonce, hourBucket). Tenants are namespaced.
      const idempotencyKey = deriveFacilitatorIdempotencyKey({
        resourceKeyId: resourceKey.id,
        payerAddress: extractPayerAddress(body.paymentPayload),
        payloadNonce: extractPayloadNonce(body.paymentPayload),
        now: ctx.now?.().getTime() ?? Date.now(),
      });
      // Resolve the effective platform fee in basis points. Per-key
      // override (resource_api_keys.fee_bps) wins; otherwise fall
      // back to the global default from config. See PRICING.md.
      const effectiveFeeBps =
        resourceKey.feeBps ?? ctx.config.platformFeeBps;
      // Insert-or-fetch the facilitator_payments row. On replay the
      // existing row is returned and we short-circuit.
      const { isNew, row } = await createOrFetchFacilitatorPayment({
        client: pool,
        resourceKeyId: resourceKey.id,
        idempotencyKey,
        network,
        asset: body.paymentRequirements.asset,
        scheme,
        amount: body.paymentRequirements.maxAmountRequired,
        recipient: body.paymentRequirements.payTo,
        feeBps: effectiveFeeBps,
      });
      if (!isNew) {
        return facilitatorSettleResponse(row);
      }

      const { response, adapterUsed, failoverFrom } = await routeSettleWithFailover(
        {
          paymentPayload: body.paymentPayload,
          paymentRequirements: body.paymentRequirements,
        },
        { registry: ctx.registry, idempotencyKey },
      );

      // Record any failover events.
      for (const ev of failoverFrom) {
        await recordFailoverEvent({
          client: pool,
          paymentId: row.id,
          primaryAdapter: ev.adapterId,
          backupAdapter: adapterUsed,
          primaryErrorCode: ev.errorCode,
          ...(ev.errorMessage !== undefined
            ? { primaryErrorMessage: ev.errorMessage }
            : {}),
        });
      }

      // Finalize the row with the outcome.
      const finalRow = await finalizeFacilitatorPayment({
        client: pool,
        id: row.id,
        status: response.settled ? "settled" : "failed",
        adapterUsed,
        ...(response.payer !== undefined ? { payer: response.payer } : {}),
        ...(response.settled && response.txHash !== undefined
          ? { txHash: response.txHash }
          : {}),
        ...(!response.settled && response.errorCode !== undefined
          ? { errorCode: response.errorCode }
          : {}),
        ...(!response.settled && response.errorMessage !== undefined
          ? { errorMessage: response.errorMessage }
          : {}),
      });

      // Fan-out webhook event. Best-effort — a queue/DB hiccup here
      // MUST NOT cause us to return an error to the resource server
      // (the settle already happened on-chain). Failures land in
      // pino at warn-level; the operator can rerun delivery from
      // the dashboard if a misconfiguration drops events.
      if (ctx.webhookQueue !== undefined) {
        try {
          await enqueueSettleEvent({
            client: pool,
            queue: ctx.webhookQueue,
            eventType: finalRow.status === "settled"
              ? "settle.succeeded"
              : "settle.failed",
            settle: {
              id: finalRow.id,
              resource_key_id: finalRow.resourceKeyId,
              network: finalRow.network,
              asset: finalRow.asset,
              scheme: finalRow.scheme,
              gross_amount: finalRow.grossAmount,
              fee_amount: finalRow.feeAmount,
              net_amount: finalRow.netAmount,
              payer: finalRow.payer,
              recipient: finalRow.recipient,
              adapter_used: finalRow.adapterUsed,
              tx_hash: finalRow.txHash,
              status: finalRow.status,
              error_code: finalRow.errorCode,
              error_message: finalRow.errorMessage,
              created_at: finalRow.createdAt.toISOString(),
              settled_at: finalRow.settledAt?.toISOString() ?? null,
            },
          });
        } catch (err) {
          app.log.warn(
            { err: err instanceof Error ? err.message : String(err), settleId: finalRow.id },
            "webhook enqueue failed — settle response unaffected",
          );
        }
      }

      return facilitatorSettleResponse(finalRow);
    },
  );
}

/**
 * Convert a facilitator_payments row to the x402 v2 SettleResponse
 * shape (§7.2).
 */
function facilitatorSettleResponse(row: {
  status: string;
  payer: string | null;
  txHash: string | null;
  network: string;
  errorCode: string | null;
  errorMessage: string | null;
}): Record<string, unknown> {
  if (row.status === "settled") {
    return {
      success: true,
      payer: row.payer ?? "",
      transaction: row.txHash ?? "",
      network: row.network,
    };
  }
  const out: Record<string, unknown> = {
    success: false,
    errorReason: row.errorCode ?? "unexpected_settle_error",
    payer: row.payer ?? "",
    transaction: "",
    network: row.network,
  };
  if (row.errorMessage !== null) out.errorMessage = row.errorMessage;
  return out;
}
