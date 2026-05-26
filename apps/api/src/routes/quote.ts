import {
  Caip2Schema,
  MerchantPolicySchema,
  type MerchantPolicyInput,
  type QuoteResponse,
} from "@suverse-pay/core-types";
import { aggregateQuotes } from "@suverse-pay/orchestrator";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerContext } from "../context.js";

const QuoteRequestSchema = z.object({
  asset: z.string().min(1),
  amount: z.string().min(1),
  preferredNetworks: z.array(Caip2Schema).min(1),
  scheme: z.string().min(1),
  policy: MerchantPolicySchema.partial().optional(),
});

export function registerQuoteRoute(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  app.post("/quote", async (req) => {
    const body = QuoteRequestSchema.parse(req.body);
    const policy = MerchantPolicySchema.parse(
      (body.policy as MerchantPolicyInput | undefined) ?? {},
    );

    const providers = ctx.registry.enabled();
    const perNetwork = await Promise.all(
      body.preferredNetworks.map((network) =>
        aggregateQuotes({
          providers,
          request: {
            network,
            asset: body.asset,
            amount: body.amount,
            scheme: body.scheme,
          },
          optimize: policy.optimize,
        }),
      ),
    );

    const allQuotes: QuoteResponse[] = perNetwork.flatMap((r) => r.quotes);
    if (allQuotes.length === 0) {
      return { quotes: [], recommended: null };
    }

    const sorted = sortByOptimize(allQuotes, policy.optimize);
    return {
      quotes: sorted,
      recommended: {
        providerId: sorted[0]!.providerId,
        network: sorted[0]!.network,
        reason: reasonFor(policy.optimize),
      },
    };
  });
}

function sortByOptimize(
  quotes: ReadonlyArray<QuoteResponse>,
  optimize: "cost" | "latency" | "success_rate",
): QuoteResponse[] {
  const out = [...quotes];
  switch (optimize) {
    case "cost":
      out.sort(
        (a, b) =>
          Number.parseFloat(a.estimatedFeeUsd) -
          Number.parseFloat(b.estimatedFeeUsd),
      );
      break;
    case "latency":
      out.sort((a, b) => a.estimatedLatencyMs - b.estimatedLatencyMs);
      break;
    case "success_rate":
      // Insertion order — aggregateQuotes already produced it from
      // registry order. Real success-rate scoring lives in router for
      // /settle; /quote is a hint-grade endpoint.
      break;
  }
  return out;
}

function reasonFor(optimize: "cost" | "latency" | "success_rate"): string {
  switch (optimize) {
    case "cost":
      return "lowest_cost";
    case "latency":
      return "lowest_latency";
    case "success_rate":
      return "first_supported";
  }
}
