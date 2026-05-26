import {
  GatewayError,
  MerchantPolicySchema,
  PaymentPayloadSchema,
  PaymentRequirementsSchema,
  ProviderError,
} from "@suverse-pay/core-types";
import { route } from "@suverse-pay/orchestrator";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerContext } from "../context.js";

const VerifyBodySchema = z.object({
  paymentPayload: PaymentPayloadSchema,
  paymentRequirements: PaymentRequirementsSchema,
  policy: MerchantPolicySchema.partial().optional(),
  providerHint: z.string().min(1).optional(),
});

/**
 * POST /verify
 *
 * Picks the best provider for the requested (network, asset, scheme)
 * tuple via the router (NO fallback — verify is a single-shot
 * read-only check), then calls `adapter.verify()` on that provider.
 */
export function registerVerifyRoute(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  app.post("/verify", async (req) => {
    const body = VerifyBodySchema.parse(req.body);

    const baseInput = body.policy ?? {};
    const hintMerged =
      body.providerHint !== undefined
        ? { ...baseInput, providerHint: body.providerHint }
        : baseInput;
    const policy = MerchantPolicySchema.parse(hintMerged);

    const providers = ctx.registry.enabled();
    const summaries = await ctx.loadHealthSummaries(providers.map((p) => p.id));
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

    if (decision.selected === null) {
      throw new GatewayError(
        "route_unsupported",
        404,
        `no healthy provider supports (network=${body.paymentRequirements.network}, asset=${body.paymentRequirements.asset}, scheme=${body.paymentRequirements.scheme})`,
      );
    }

    const provider = ctx.registry.getById(decision.selected);
    if (provider === undefined) {
      throw new GatewayError(
        "unexpected_settle_error",
        500,
        `router selected ${decision.selected} but registry has no such adapter`,
      );
    }

    try {
      const result = await provider.adapter.verify({
        paymentPayload: body.paymentPayload,
        paymentRequirements: body.paymentRequirements,
      });
      return {
        valid: result.valid,
        providerId: provider.id,
        payer: result.payer ?? null,
        errorCode: result.errorCode ?? null,
        errorMessage: result.errorMessage ?? null,
        verifiedAt: result.verifiedAt,
      };
    } catch (err) {
      // ProviderError surfaces to the global handler with provider
      // context; unknown errors bubble as 500.
      if (err instanceof ProviderError) throw err;
      throw new GatewayError(
        "unexpected_settle_error",
        502,
        `verify failed at provider ${provider.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }
  });
}
