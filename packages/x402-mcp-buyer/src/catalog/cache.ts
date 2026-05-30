/**
 * In-process catalog cache. The MCP runs as a single subprocess
 * per host; an in-memory TTL cache is the simplest thing that
 * works. No persistence — a restart fetches fresh, which is fine
 * given fetch-from-CDN is sub-100ms.
 */

import type { CatalogSnapshot } from "./types.js";
import { fetchCatalog, type AggregateOptions } from "./aggregate.js";

const DEFAULT_TTL_MS = 60_000;

interface CacheState {
  snapshot: CatalogSnapshot | null;
  fetchedAt: number;
  inflight: Promise<CatalogSnapshot> | null;
}

const state: CacheState = {
  snapshot: null,
  fetchedAt: 0,
  inflight: null,
};

export interface GetCatalogOptions extends AggregateOptions {
  /** Bypass cache. */
  force?: boolean;
  /** Override TTL (ms). */
  ttlMs?: number;
}

export async function getCatalog(
  opts: GetCatalogOptions = {},
): Promise<CatalogSnapshot> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();
  const fresh =
    !opts.force &&
    state.snapshot !== null &&
    now - state.fetchedAt < ttl;
  if (fresh && state.snapshot !== null) {
    return state.snapshot;
  }
  if (state.inflight) return state.inflight;
  state.inflight = fetchCatalog(opts).then(
    (snap) => {
      state.snapshot = snap;
      state.fetchedAt = Date.now();
      state.inflight = null;
      return snap;
    },
    (err: unknown) => {
      state.inflight = null;
      throw err;
    },
  );
  return state.inflight;
}

/** Test hook — wipe the cache between tests. */
export function _resetCacheForTests(): void {
  state.snapshot = null;
  state.fetchedAt = 0;
  state.inflight = null;
}
