import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../context.js";

/**
 * GET /metrics/summary
 *
 * Aggregate stats — payment counts by status, per-provider attempt
 * success/fail counts, rolling success rate. Powered by
 * `ctx.loadMetrics()` so the route does not embed SQL.
 */
export function registerMetricsRoute(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  app.get("/metrics/summary", async () => {
    return ctx.loadMetrics();
  });
}
