import type {
  OptimizeStrategy,
  QuoteRequest,
  QuoteResponse,
} from "@suverse-pay/core-types";
import type { RegisteredProvider } from "./types.js";

/**
 * Calls `adapter.quote()` on every candidate provider in parallel,
 * collects the successful responses, and orders them by the requested
 * optimize strategy. Adapters that throw are silently dropped — quote
 * is a non-binding pricing call, not a hard dependency.
 *
 * Pure orchestration: takes adapters via the RegisteredProvider list,
 * no DB / Redis. Health stats are not consulted here; the router
 * (which DOES see health stats) is the gate that decides whether a
 * provider is offered at all.
 */
export async function aggregateQuotes(input: {
  providers: ReadonlyArray<RegisteredProvider>;
  request: QuoteRequest;
  optimize: OptimizeStrategy;
}): Promise<{
  quotes: QuoteResponse[];
  recommended: { providerId: string; reason: string } | null;
}> {
  const settled = await Promise.allSettled(
    input.providers.map(async (p) => {
      const supported = await p.adapter.supports({
        network: input.request.network,
        asset: input.request.asset,
        scheme: input.request.scheme,
      });
      if (!supported.supported) {
        throw new Error(`provider ${p.id} does not support route`);
      }
      return p.adapter.quote(input.request);
    }),
  );

  const quotes = settled
    .filter(
      (r): r is PromiseFulfilledResult<QuoteResponse> => r.status === "fulfilled",
    )
    .map((r) => r.value);

  if (quotes.length === 0) {
    return { quotes: [], recommended: null };
  }

  const sorted = [...quotes];
  let reason: string;
  switch (input.optimize) {
    case "cost":
      sorted.sort(
        (a, b) =>
          Number.parseFloat(a.estimatedFeeUsd) -
          Number.parseFloat(b.estimatedFeeUsd),
      );
      reason = "lowest_cost";
      break;
    case "latency":
      sorted.sort((a, b) => a.estimatedLatencyMs - b.estimatedLatencyMs);
      reason = "lowest_latency";
      break;
    case "success_rate":
      // No DB data here; preserve insertion order and label as such.
      reason = "first_supported";
      break;
  }

  return {
    quotes: sorted,
    recommended: { providerId: sorted[0]!.providerId, reason },
  };
}
