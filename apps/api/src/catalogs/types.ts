/**
 * Shared types for the external-catalog parser (phase 2 of the
 * unified-search feature). Each upstream source (CDP Bazaar, x402.org,
 * future...) implements `CatalogSource.fetch` and returns a normalised
 * `RawEndpoint[]` that the upsert layer writes into `external_endpoints`.
 */

/**
 * One row as we normalise it from any upstream catalog. Keys mirror the
 * `external_endpoints` columns the upsert layer writes. `payTo` is the
 * primary settlement address — taken from `accepts[0].payTo` when the
 * source returns multiple accepts under one resource (CDP entries are
 * payTo-grouped so all accepts under one resource share a primary payTo).
 */
export interface RawEndpoint {
  /** Public URL the buyer would call to start a paid request. */
  readonly resource: string;
  /** Primary settlement address (accepts[0].payTo). */
  readonly payTo: string;
  /** x402 protocol version this entry was advertised under. */
  readonly x402Version?: number;
  /** Free-form description from the seller (or null). */
  readonly description?: string;
  /** The complete `accepts[]` array as returned by the source. */
  readonly accepts: unknown[];
  /** Top-level `extensions` block (e.g. `{bazaar: {info, schema}}`). */
  readonly extensions?: unknown;
  /** Quality signals: l30DaysTotalCalls, uniquePayers, lastCalledAt. */
  readonly quality?: unknown;
  /** Verbatim source entry for debug + future re-parsing. */
  readonly raw: unknown;
}

/**
 * A pluggable catalog source. Add a new one by defining its fetcher and
 * appending to `SOURCES` in sync.ts. Sources are isolated: one source
 * throwing must not poison the others (the syncer try/catches per source).
 */
export interface CatalogSource {
  /** Human-friendly name for logs. */
  readonly name: string;
  /** Stable id stored in `external_endpoints.source`. */
  readonly id: string;
  /** Returns the current full list of endpoints visible in this source. */
  fetch(opts: FetchOptions): Promise<RawEndpoint[]>;
}

export interface FetchOptions {
  /** Optional override for tests / curl-style debug; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Per-source soft cap on the number of paginated requests (default 20). */
  readonly maxRequests?: number;
  readonly logger?: SyncLogger;
}

export interface SyncLogger {
  info: (msg: string, ctx?: Record<string, unknown>) => void;
  warn: (msg: string, ctx?: Record<string, unknown>) => void;
  error: (msg: string, ctx?: Record<string, unknown>) => void;
}

/** Outcome of a single per-source sync pass (recorded in external_catalog_runs). */
export interface SourceRunResult {
  readonly source: string;
  readonly status: "ok" | "partial" | "error";
  readonly fetched: number;
  readonly upserted: number;
  readonly archived: number;
  readonly error?: string;
}
