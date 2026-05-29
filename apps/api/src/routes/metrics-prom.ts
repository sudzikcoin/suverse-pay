import type { FastifyInstance } from "fastify";
import { metricsRegistry } from "../lib/metrics.js";

/**
 * GET /metrics — Prometheus text-format scrape endpoint. Phase 4
 * Block 1 Sub-task 4.
 *
 * Separate from `/metrics/summary` (which returns a JSON snapshot for
 * humans / the admin UI). This route is consumed by Prometheus via the
 * scrape config in `prometheus/prometheus.yml` and feeds the Grafana
 * dashboard.
 *
 * No auth — the docker-compose Prometheus runs on the operator's
 * machine and reaches apps/api over the docker bridge. If apps/api is
 * exposed to the internet, put the /metrics path behind a network ACL
 * (cloudflare, nginx allowlist) — prom-client output is not sensitive
 * by default but enumerating per-resource-key labels can leak the
 * footprint.
 */
export function registerPromMetricsRoute(app: FastifyInstance): void {
  app.get("/metrics", async (_req, reply) => {
    const body = await metricsRegistry.metrics();
    reply.header("Content-Type", metricsRegistry.contentType);
    return body;
  });
}
