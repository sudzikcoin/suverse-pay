/**
 * Admin-only routes for the external catalog mirror (phase 2).
 *
 *   POST /admin/catalog/sync   — fire a one-shot full sync. Returns 202
 *                                with {status: "started"} and runs the
 *                                sync in the background so the request
 *                                returns fast even when CDP paginates
 *                                through 20+ pages.
 *   GET  /admin/catalog/stats  — per-source summary from
 *                                external_catalog_runs + total active +
 *                                top-10 by l30DaysTotalCalls.
 *
 * Auth: the api plugin's global Bearer-admin-key check guards every
 * route under apps/api, so these endpoints are admin-only by default.
 * No additional auth wiring needed.
 */
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../context.js";
import { syncAllCatalogs } from "../catalogs/sync.js";

export function registerAdminCatalogRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  /**
   * POST /admin/catalog/sync
   *
   * Kicks off a full sync of every configured source. Runs detached so
   * the response returns immediately. The caller can poll /stats to see
   * when each source last_run_at updates.
   */
  app.post("/admin/catalog/sync", async (req, reply) => {
    // Fire-and-forget; do NOT await syncAllCatalogs so a slow CDP page
    // doesn't tie up the HTTP request. Errors are logged inside the
    // syncer (per-source try/catch) and recorded in external_catalog_runs.
    // Bridge Fastify's pino logger to the syncer's `{info, warn, error}`
    // SyncLogger contract. Pino's signature is `(obj, msg)` (obj first,
    // not last) — Fastify's overloads reject `(msg, obj)`.
    const logger = {
      info: (msg: string, obj: Record<string, unknown> = {}) =>
        req.log.info(obj, msg),
      warn: (msg: string, obj: Record<string, unknown> = {}) =>
        req.log.warn(obj, msg),
      error: (msg: string, obj: Record<string, unknown> = {}) =>
        req.log.error(obj, msg),
    };
    void syncAllCatalogs(ctx.pool!, { logger })
      .then((results) => {
        req.log.info({ results }, "admin: catalog sync done");
      })
      .catch((err) => {
        req.log.error(
          { error: err instanceof Error ? err.message : String(err) },
          "admin: catalog sync threw",
        );
      });
    return reply.code(202).send({
      status: "started",
      message:
        "catalog sync running in background; poll /admin/catalog/stats for per-source last_run_at",
    });
  });

  /**
   * GET /admin/catalog/stats
   *
   * Three sections:
   *   - active_total: count of non-archived rows in external_endpoints
   *   - per_source: latest run summary per source (from external_catalog_runs)
   *     joined with current per-source active row counts (LEFT JOIN so a
   *     source that has never run shows up too)
   *   - top10_by_quality: 10 most-called endpoints by CDP's
   *     l30DaysTotalCalls (NULL-safe)
   */
  app.get("/admin/catalog/stats", async () => {
    const [active, perSource, top10] = await Promise.all([
      ctx.pool!.query<{ active_total: number }>(
        `SELECT count(*)::int AS active_total
           FROM external_endpoints
          WHERE archived_at IS NULL`,
      ),
      ctx.pool!.query<{
        source: string;
        last_run_at: string | null;
        last_status: string | null;
        last_error: string | null;
        last_fetched_count: number | null;
        last_upserted_count: number | null;
        last_archived_count: number | null;
        total_runs: number | null;
        active_count: number | null;
      }>(
        `SELECT r.source,
                r.last_run_at,
                r.last_status,
                r.last_error,
                r.last_fetched_count,
                r.last_upserted_count,
                r.last_archived_count,
                r.total_runs,
                (SELECT count(*)::int
                   FROM external_endpoints e
                  WHERE e.source = r.source
                    AND e.archived_at IS NULL) AS active_count
           FROM external_catalog_runs r
          ORDER BY r.last_run_at DESC NULLS LAST`,
      ),
      ctx.pool!.query<{
        resource_url: string;
        pay_to: string;
        description: string | null;
        l30_days_total_calls: number | null;
      }>(
        `SELECT resource_url,
                pay_to,
                description,
                ((quality_signals->>'l30DaysTotalCalls')::int) AS l30_days_total_calls
           FROM external_endpoints
          WHERE archived_at IS NULL
            AND quality_signals ? 'l30DaysTotalCalls'
          ORDER BY ((quality_signals->>'l30DaysTotalCalls')::int) DESC NULLS LAST
          LIMIT 10`,
      ),
    ]);

    return {
      active_total: active.rows[0]?.active_total ?? 0,
      per_source: perSource.rows,
      top10_by_quality: top10.rows,
    };
  });
}
