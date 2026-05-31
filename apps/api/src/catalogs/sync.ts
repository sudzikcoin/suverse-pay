/**
 * Top-level catalog syncer. Iterates the configured `SOURCES`, calls each
 * fetcher, upserts the rows into `external_endpoints`, soft-archives
 * URLs that disappeared, and records the per-source run summary in
 * `external_catalog_runs`. One source failing does NOT stop the loop —
 * the others run, and the failed source records `last_status='error'`
 * so /admin/catalog/stats surfaces it.
 *
 * Two ways to drive it:
 *   - `syncAllCatalogs(pool, logger)` — one-shot. Used by manual triggers
 *     (POST /admin/catalog/sync) and by the cron tick.
 *   - `CatalogSyncer.start()` — long-running scheduler that ticks every
 *     `intervalMs`. Mirrors `MetricsRefresher` so index.ts wires both
 *     the same way. Returns a stopper for graceful shutdown.
 */
import type { Pool } from "pg";
import { cdpBazaarSource } from "./sources/cdp-bazaar.js";
import { x402OrgSource } from "./sources/x402-org.js";
import type { CatalogSource, SourceRunResult, SyncLogger } from "./types.js";
import {
  markArchivedIfMissing,
  recordRun,
  upsertEndpoints,
} from "./upsert.js";

export const SOURCES: CatalogSource[] = [cdpBazaarSource, x402OrgSource];

export interface SyncAllOptions {
  /** Override the source list (tests pass mock sources here). */
  readonly sources?: ReadonlyArray<CatalogSource>;
  readonly logger?: SyncLogger;
  readonly fetchImpl?: typeof fetch;
}

export async function syncAllCatalogs(
  pool: Pool,
  opts: SyncAllOptions = {},
): Promise<SourceRunResult[]> {
  const sources = opts.sources ?? SOURCES;
  const log = opts.logger;
  const results: SourceRunResult[] = [];

  for (const source of sources) {
    const started = Date.now();
    log?.info(`catalog-sync: ${source.id} starting`);
    let fetched: ReadonlyArray<unknown>;
    try {
      fetched = await source.fetch({
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
        ...(log !== undefined ? { logger: log } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.error(`catalog-sync: ${source.id} fetch threw`, { error: msg });
      const r: SourceRunResult = {
        source: source.id,
        status: "error",
        fetched: 0,
        upserted: 0,
        archived: 0,
        error: msg,
      };
      results.push(r);
      try {
        await recordRun(pool, r);
      } catch (e) {
        log?.error(`catalog-sync: ${source.id} run-recording failed`, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      continue;
    }

    const endpoints = fetched as ReadonlyArray<
      import("./types.js").RawEndpoint
    >;
    const upserted = await upsertEndpoints(
      pool,
      source.id,
      endpoints,
      log ? { warn: log.warn } : undefined,
    );
    const archived = await markArchivedIfMissing(pool, source.id, endpoints);
    // "partial" when upstream returned 200 but we couldn't write every row
    // (per-row INSERT exception logged inside upsertEndpoints).
    const status: SourceRunResult["status"] =
      endpoints.length > 0 && upserted < endpoints.length ? "partial" : "ok";
    const r: SourceRunResult = {
      source: source.id,
      status,
      fetched: endpoints.length,
      upserted,
      archived,
    };
    results.push(r);
    try {
      await recordRun(pool, r);
    } catch (e) {
      log?.error(`catalog-sync: ${source.id} run-recording failed`, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    log?.info(`catalog-sync: ${source.id} done`, {
      ms: Date.now() - started,
      ...r,
    });
  }
  return results;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // every hour, on the hour-ish

export interface CatalogSyncerOptions {
  readonly pool: Pool;
  readonly intervalMs?: number;
  readonly logger?: SyncLogger;
  /** Set true to run a tick immediately on start() (helpful at boot). */
  readonly runOnStart?: boolean;
}

/**
 * Long-running scheduler. Mirrors `MetricsRefresher` shape: `start()`
 * returns a `stop()` for graceful shutdown. Ticks every `intervalMs`,
 * skipping a tick that's still in flight (so a slow CDP page doesn't
 * pile up overlapping syncs).
 */
export class CatalogSyncer {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly pool: Pool;
  private readonly intervalMs: number;
  private readonly logger: SyncLogger | undefined;
  private readonly runOnStart: boolean;

  constructor(opts: CatalogSyncerOptions) {
    this.pool = opts.pool;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.logger = opts.logger;
    this.runOnStart = opts.runOnStart ?? false;
  }

  start(): () => void {
    if (this.runOnStart) {
      void this.tick().catch((err) =>
        this.logger?.error("catalog-syncer: initial tick failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    this.timer = setInterval(() => {
      void this.tick().catch((err) =>
        this.logger?.error("catalog-syncer: tick failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }, this.intervalMs);
    return () => {
      if (this.timer !== undefined) clearInterval(this.timer);
      this.timer = undefined;
    };
  }

  private async tick(): Promise<void> {
    if (this.running) {
      this.logger?.warn("catalog-syncer: previous tick still running; skipping");
      return;
    }
    this.running = true;
    try {
      await syncAllCatalogs(this.pool, this.logger ? { logger: this.logger } : {});
    } finally {
      this.running = false;
    }
  }
}
