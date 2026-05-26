import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../context.js";

/**
 * GET /providers
 *
 * Lists configured providers, their merged static + discovered
 * capabilities (excluding superseded rows), and their latest health
 * summary. Delegates to ProviderRegistry + ServerContext.loadHealthSummaries.
 */
export function registerProvidersRoute(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  app.get("/providers", async () => {
    const providers = ctx.registry.list();
    const ids = providers.map((p) => p.id);
    const [capsByProvider, summaries] = await Promise.all([
      Promise.all(
        providers.map(async (p) => ({
          id: p.id,
          caps: await ctx.registry.listCapabilities(p.id),
        })),
      ),
      ctx.loadHealthSummaries(ids),
    ]);
    const capsMap = new Map(capsByProvider.map((x) => [x.id, x.caps]));

    return {
      providers: providers.map((p) => {
        const caps = capsMap.get(p.id) ?? [];
        const summary = summaries.get(p.id);
        return {
          id: p.id,
          displayName: p.displayName,
          enabled: p.enabled,
          capabilities: caps.map((c) => ({
            network: c.network,
            asset: c.asset,
            scheme: c.scheme,
            isStatic: c.isStatic,
            isDiscovered: c.isDiscovered,
            discoveredAt: c.discoveredAt?.toISOString() ?? null,
          })),
          health: summary
            ? {
                status: summary.lastCheck?.status ?? "unknown",
                successRate7d: summary.successRate7d,
                avgLatencyMs: summary.avgLatencyMs7d,
                lastCheckAt: summary.lastCheck?.checkedAt.toISOString() ?? null,
              }
            : { status: "unknown", lastCheckAt: null },
        };
      }),
    };
  });
}
