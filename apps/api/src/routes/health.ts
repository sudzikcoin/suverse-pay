import type { FastifyInstance } from "fastify";

/**
 * Liveness check. Returns 200 if the API process is up. Does NOT
 * verify providers, Postgres, or Redis — use `/providers` for upstream
 * health. The auth plugin exempts this path (industry convention for
 * k8s-style probes).
 */
export function registerHealthRoute(app: FastifyInstance): void {
  app.get("/health", async () => ({ status: "ok" }));
}
