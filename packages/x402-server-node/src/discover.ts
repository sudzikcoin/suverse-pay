/**
 * Facilitator-extras auto-discovery.
 *
 * Suverse-pay (and PayAI / CDP / etc.) publish per-kind operational
 * context — Solana feePayer pubkey, Cosmos grantee address + chainId,
 * EVM EIP-712 USDC domain — via `GET /facilitator/supported`'s per-kind
 * `extra` field (added in suverse-pay PR-A, 2026-05-30).
 *
 * This module caches the facilitator's `/supported` response in-process
 * and exposes a lookup so `buildChallenge()` can merge the facilitator's
 * extras into each 402 challenge entry automatically. Sellers
 * configuring `acceptedPayments` no longer need to know infrastructure
 * details like the Solana feePayer pubkey.
 *
 * Failure mode: if the facilitator is unreachable or returns a body we
 * don't recognise, the lookup returns `undefined` (treated as "no
 * extras to merge"). The seller's own `extra` from the AcceptedPayment
 * config still flows through unchanged. A warning is logged once per
 * cache window.
 */

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 5_000;

interface CachedSupported {
  /** `${network}:${scheme}` → `extra` object, or absent. */
  readonly byKind: ReadonlyMap<string, Record<string, unknown>>;
  /** Epoch ms. */
  readonly fetchedAt: number;
  /** Failure marker — when set, the fetch errored and `byKind` is empty. */
  readonly error?: string;
}

const cache = new Map<string, CachedSupported>();
const inflight = new Map<string, Promise<CachedSupported>>();

export interface FacilitatorExtrasOptions {
  /** Cache TTL in ms. Default: 1 hour. */
  readonly ttlMs?: number;
  /** Inject for tests + custom TLS. */
  readonly fetchImpl?: typeof fetch;
  /** Optional logger (warns on probe failure). */
  readonly logger?: Pick<Console, "warn">;
}

/**
 * Look up per-kind extras the facilitator publishes for
 * (`network`, `scheme`). Returns `undefined` if the facilitator is
 * unreachable, has no entry for that kind, or hasn't been polled yet
 * and the lazy fetch errors.
 *
 * Concurrent calls against the same facilitator URL share a single
 * in-flight fetch — the second caller awaits the first's promise.
 */
export async function getFacilitatorExtras(
  facilitatorUrl: string,
  network: string,
  scheme: string,
  opts: FacilitatorExtrasOptions = {},
): Promise<Record<string, unknown> | undefined> {
  const cached = await ensureCached(facilitatorUrl, opts);
  return cached.byKind.get(keyOf(network, scheme));
}

/**
 * Returns the full `${network}|${scheme}` → `extra` map for the
 * facilitator's /supported response. Cheaper than calling
 * `getFacilitatorExtras` once per accept entry when a challenge has
 * multiple accepts — caller picks per-kind out of the result.
 */
export async function getAllFacilitatorExtras(
  facilitatorUrl: string,
  opts: FacilitatorExtrasOptions = {},
): Promise<ReadonlyMap<string, Record<string, unknown>>> {
  const cached = await ensureCached(facilitatorUrl, opts);
  return cached.byKind;
}

/**
 * Compose the per-kind lookup key. Exposed for tests that pre-populate
 * the cache via `_setCachedFacilitatorExtras` — keep it in sync.
 */
export function facilitatorExtrasKey(network: string, scheme: string): string {
  return keyOf(network, scheme);
}

/**
 * Test-only: pre-populate the cache with a synthetic /supported
 * response. Bypasses the HTTP fetch — useful for unit tests that
 * exercise `buildChallenge`'s merge path without spinning up a fake
 * facilitator. Pair with `_resetFacilitatorExtrasCache` between
 * tests.
 */
export function _setCachedFacilitatorExtras(
  facilitatorUrl: string,
  byKind: ReadonlyMap<string, Record<string, unknown>>,
): void {
  cache.set(normaliseUrl(facilitatorUrl), {
    byKind: new Map(byKind),
    fetchedAt: Date.now(),
  });
}

/**
 * Kick off a background warm of the cache for the given facilitator
 * URL. Returns immediately; the promise is dropped. Used at middleware
 * boot so the first 402 doesn't pay the fetch latency. Safe to call
 * multiple times — concurrent warms are deduped.
 */
export function warmFacilitatorCache(
  facilitatorUrl: string,
  opts: FacilitatorExtrasOptions = {},
): void {
  void ensureCached(facilitatorUrl, opts).catch(() => {
    // ensureCached already logs; the void-cast just keeps unhandled
    // rejection warnings out of the caller's stderr.
  });
}

/**
 * Test-only: wipe the in-process cache. Exported so vitest tests can
 * isolate themselves; not part of the public API of the package
 * (re-exported only via `index.ts` if needed in app code, but not
 * advertised in README).
 */
export function _resetFacilitatorExtrasCache(): void {
  cache.clear();
  inflight.clear();
}

async function ensureCached(
  facilitatorUrl: string,
  opts: FacilitatorExtrasOptions,
): Promise<CachedSupported> {
  const normalised = normaliseUrl(facilitatorUrl);
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();
  const existing = cache.get(normalised);
  if (existing !== undefined && now - existing.fetchedAt < ttlMs) {
    return existing;
  }
  const pending = inflight.get(normalised);
  if (pending !== undefined) {
    return pending;
  }
  const promise = fetchSupported(normalised, opts).finally(() => {
    inflight.delete(normalised);
  });
  inflight.set(normalised, promise);
  const result = await promise;
  cache.set(normalised, result);
  return result;
}

async function fetchSupported(
  facilitatorUrl: string,
  opts: FacilitatorExtrasOptions,
): Promise<CachedSupported> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${facilitatorUrl}/facilitator/supported`;
  const fetchedAt = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const reason = `HTTP ${res.status}`;
      opts.logger?.warn(
        `[x402-server] facilitator /supported returned ${reason}; auto-discovery disabled until next TTL window. url=${url}`,
      );
      return { byKind: new Map(), fetchedAt, error: reason };
    }
    const body = (await res.json()) as unknown;
    return { byKind: parseKinds(body), fetchedAt };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    opts.logger?.warn(
      `[x402-server] facilitator /supported probe failed; auto-discovery disabled until next TTL window. url=${url} error=${reason}`,
    );
    return { byKind: new Map(), fetchedAt, error: reason };
  }
}

/**
 * Parse the suverse-pay facilitator /supported body into a per-kind
 * lookup. We only consume the shape we recognise:
 *
 *   { kinds: [ { scheme, network, extra?: object }, ... ], ... }
 *
 * Anything else (legacy shapes, future fields) is ignored
 * defensively — missing `extra` on a kind just means "no extras to
 * merge for this kind".
 */
function parseKinds(body: unknown): ReadonlyMap<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  if (body === null || typeof body !== "object") return out;
  const kinds = (body as Record<string, unknown>)["kinds"];
  if (!Array.isArray(kinds)) return out;
  for (const k of kinds) {
    if (k === null || typeof k !== "object") continue;
    const kr = k as Record<string, unknown>;
    if (typeof kr["scheme"] !== "string" || typeof kr["network"] !== "string") {
      continue;
    }
    const extra = kr["extra"];
    if (extra === null || typeof extra !== "object" || Array.isArray(extra)) {
      continue;
    }
    if (Object.keys(extra as Record<string, unknown>).length === 0) {
      continue;
    }
    out.set(
      keyOf(kr["network"], kr["scheme"]),
      extra as Record<string, unknown>,
    );
  }
  return out;
}

function keyOf(network: string, scheme: string): string {
  return `${network}|${scheme}`;
}

function normaliseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
