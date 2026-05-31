/**
 * DB layer for the catalog parser: upsert RawEndpoint rows + soft-archive
 * URLs that disappeared from their source + record the per-source run
 * summary. Pure SQL — no HTTP, no logging side effects beyond the rows
 * the caller decides to log.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { RawEndpoint, SourceRunResult } from "./types.js";

/**
 * UPSERT a batch of endpoints scraped from one source. Conflict on
 * (resource_url, pay_to) is intentional: the same endpoint can be
 * advertised in multiple catalogs and we keep the LAST writer (whichever
 * source refreshed it most recently). Discarding all data on conflict
 * would lose newer quality_signals; we update every refreshable field
 * including `source` so per-source counts reflect "currently visible
 * from this source" not "first seen here".
 *
 * Reactivates rows that had been soft-archived (`archived_at = NULL`).
 * Returns the count of rows actually written (matches input length on
 * success; lower when some entries fail the per-row INSERT — they're
 * logged and skipped, not raised).
 */
export async function upsertEndpoints(
  pool: Pool,
  sourceId: string,
  endpoints: ReadonlyArray<RawEndpoint>,
  logger?: { warn: (msg: string, ctx?: Record<string, unknown>) => void },
): Promise<number> {
  let upserted = 0;
  for (const ep of endpoints) {
    try {
      // search_text mirrors the dashboard-search lowercased concat —
      // migration 020 maintains the column shape; upsert keeps it fresh
      // on every refresh so a renamed/redescribed endpoint becomes
      // searchable within one sync tick.
      const searchText = (
        (ep.description ?? "") +
        " " +
        ep.resource
      ).toLowerCase();
      await pool.query(
        `INSERT INTO external_endpoints
          (id, source, resource_url, pay_to, x402_version, description,
           accepts, extensions, quality_signals, raw_payload, search_text,
           first_seen_at, last_seen_at, archived_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW(), NULL)
         ON CONFLICT (resource_url, pay_to) DO UPDATE SET
           source = EXCLUDED.source,
           x402_version = EXCLUDED.x402_version,
           description = EXCLUDED.description,
           accepts = EXCLUDED.accepts,
           extensions = EXCLUDED.extensions,
           quality_signals = EXCLUDED.quality_signals,
           raw_payload = EXCLUDED.raw_payload,
           search_text = EXCLUDED.search_text,
           last_seen_at = NOW(),
           archived_at = NULL`,
        [
          randomUUID(),
          sourceId,
          ep.resource,
          ep.payTo,
          ep.x402Version ?? null,
          ep.description ?? null,
          JSON.stringify(ep.accepts),
          ep.extensions !== undefined ? JSON.stringify(ep.extensions) : null,
          ep.quality !== undefined ? JSON.stringify(ep.quality) : null,
          JSON.stringify(ep.raw),
          searchText,
        ],
      );
      upserted++;
    } catch (err) {
      logger?.warn(`catalog upsert row failed; skipping`, {
        source: sourceId,
        resource: ep.resource,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return upserted;
}

/**
 * Soft-archive every previously-seen URL under this source that is no
 * longer present in the current fetch. Rows stay (so the search index
 * can show "last seen 3 days ago") but stop counting as active. If the
 * URL reappears in a later fetch, the upsert above clears archived_at.
 *
 * Returns the count of newly-archived rows.
 */
export async function markArchivedIfMissing(
  pool: Pool,
  sourceId: string,
  currentEndpoints: ReadonlyArray<RawEndpoint>,
): Promise<number> {
  // Edge case: an empty fetch shouldn't archive every row from this source
  // (that's almost always a transient upstream outage, not a real catalog
  // wipe). Caller is expected to mark the run `error` / `partial` and let
  // the next successful sync do the bookkeeping.
  if (currentEndpoints.length === 0) return 0;
  const currentUrls = currentEndpoints.map((e) => e.resource);
  // pg-mem 3.0.14 doesn't implement `<> ALL($1::text[])`; the equivalent
  // `NOT (col = ANY($1::text[]))` works on both pg-mem and real Postgres.
  const { rowCount } = await pool.query(
    `UPDATE external_endpoints
        SET archived_at = NOW()
      WHERE source = $1
        AND archived_at IS NULL
        AND NOT (resource_url = ANY($2::text[]))`,
    [sourceId, currentUrls],
  );
  return rowCount ?? 0;
}

/**
 * Record the per-source run summary so /admin/catalog/stats serves O(sources).
 * UPSERT keyed on `source` — one row per source, total_runs increments each call.
 */
export async function recordRun(
  pool: Pool,
  r: SourceRunResult,
): Promise<void> {
  await pool.query(
    `INSERT INTO external_catalog_runs
        (source, last_run_at, last_status, last_error,
         last_fetched_count, last_upserted_count, last_archived_count, total_runs)
     VALUES ($1, NOW(), $2, $3, $4, $5, $6, 1)
     ON CONFLICT (source) DO UPDATE SET
       last_run_at = NOW(),
       last_status = EXCLUDED.last_status,
       last_error = EXCLUDED.last_error,
       last_fetched_count = EXCLUDED.last_fetched_count,
       last_upserted_count = EXCLUDED.last_upserted_count,
       last_archived_count = EXCLUDED.last_archived_count,
       total_runs = external_catalog_runs.total_runs + 1`,
    [
      r.source,
      r.status,
      r.error ?? null,
      r.fetched,
      r.upserted,
      r.archived,
    ],
  );
}
