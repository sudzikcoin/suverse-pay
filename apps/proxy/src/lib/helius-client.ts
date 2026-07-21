/**
 * Single door for every outbound Helius call — dual-key failover.
 *
 * We hold two Helius free-tier keys (HELIUS_API_KEY_1, HELIUS_API_KEY_2).
 * All Helius fetches go through `heliusFetch()`; the switching logic
 * lives HERE and nowhere else. When the active key hits its rate/credit
 * limit (HTTP 429, or a credit-limit error body), that key is marked
 * "cooling down", we switch to the other key and retry the call once.
 * After the cooldown window passes the key is eligible again, and we
 * always prefer key_1 when both are healthy. If BOTH keys are cooling,
 * we throw `HeliusAllKeysCoolingError` and log it — the call is never
 * silently dropped.
 *
 * Backward compatible: `HELIUS_API_KEY_1` falls back to the legacy
 * `HELIUS_API_KEY`, and `HELIUS_API_KEY_2` is optional. A single-key
 * deploy therefore behaves exactly as before (no failover, no retry).
 *
 * Idempotency: every current Helius call site is read-only (getAsset,
 * priority-fee, simulate, tx-decode, address history, token holders),
 * so retrying on the OTHER key after a 429 never duplicates a side
 * effect. The retry is only ever issued after the first attempt was
 * rejected (never after a success), so a successful call is sent once.
 */
import pino from "pino";

import type { InternalHandlerResult } from "../handlers/types.js";

/** Structural logger — pino satisfies this, tests pass a capture stub. */
export interface HeliusLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface HeliusFetchOpts {
  /** Injected fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-attempt abort timeout in ms. Applied fresh to each retry. */
  timeoutMs?: number;
  /** Override the module logger (tests capture switch events here). */
  logger?: HeliusLogger;
  /**
   * Explicit key list, overriding the env-derived keys. Used by the
   * token-metadata lib, which receives a caller-supplied key directly.
   * Empty/undefined falls back to the configured HELIUS_API_KEY_1/_2.
   * The switching + cooldown logic is identical regardless of source.
   */
  keys?: string[];
}

export class HeliusNotConfiguredError extends Error {
  constructor() {
    super("helius_not_configured: no HELIUS_API_KEY_1/_2 in environment");
    this.name = "HeliusNotConfiguredError";
  }
}

export class HeliusAllKeysCoolingError extends Error {
  constructor(
    readonly reason: "429" | "credit",
    readonly retryAfterMs: number,
  ) {
    super(`helius_all_keys_cooling: last reason=${reason}, retry in ${retryAfterMs}ms`);
    this.name = "HeliusAllKeysCoolingError";
  }
}

const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * How long an exhausted key stays "cooling" before it's eligible
 * again. A free-tier RPS 429 resets within seconds; a monthly credit
 * cap resets far later — 60s means at worst we re-probe key_1 once a
 * minute, fail fast, and drop straight back to key_2. Tunable via env.
 */
function cooldownMs(): number {
  const raw = process.env["HELIUS_COOLDOWN_MS"];
  const n = raw !== undefined && raw !== "" ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_COOLDOWN_MS;
}

/** key string -> epoch ms until which that key is cooling down. */
const cooldownUntil = new Map<string, number>();

let defaultLogger: HeliusLogger | undefined;
function getLogger(explicit?: HeliusLogger): HeliusLogger {
  if (explicit) return explicit;
  if (!defaultLogger) {
    defaultLogger = pino({
      name: "helius-failover",
      level: process.env["LOG_LEVEL"] ?? "info",
    });
  }
  return defaultLogger;
}

function firstNonEmpty(...vals: Array<string | undefined>): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

/**
 * Configured keys in preference order: key_1 first, key_2 second.
 * key_1 falls back to legacy HELIUS_API_KEY. A key_2 equal to key_1 is
 * dropped so we never "fail over" onto the same credit pool.
 */
export function loadHeliusKeys(): string[] {
  const k1 = firstNonEmpty(
    process.env["HELIUS_API_KEY_1"],
    process.env["HELIUS_API_KEY"],
  );
  const k2 = firstNonEmpty(process.env["HELIUS_API_KEY_2"]);
  const keys: string[] = [];
  if (k1) keys.push(k1);
  if (k2 && k2 !== k1) keys.push(k2);
  return keys;
}

/** True when at least one Helius key is configured. */
export function heliusConfigured(): boolean {
  return loadHeliusKeys().length > 0;
}

function slotLabel(keys: string[], key: string): string {
  const i = keys.indexOf(key);
  return i >= 0 ? `key_${i + 1}` : "key_?";
}

function maskKey(key: string): string {
  return key.length <= 8 ? "****" : `${key.slice(0, 8)}…`;
}

function isHealthy(key: string, now: number): boolean {
  return (cooldownUntil.get(key) ?? 0) <= now;
}

/**
 * Credit / rate-limit markers Helius returns in a body. Kept specific
 * (multi-word phrases) so a legitimate 200 payload — e.g. an NFT named
 * "Credits" — is never misread as an exhaustion signal.
 */
const CREDIT_RE =
  /credit[\s-]?limit|exceeded your credit|insufficient credits|out of credits|credits?\s+(?:limit|exceeded|exhausted)|rate[\s-]?limit(?:\s+exceeded)?|too many requests/i;

/** Classify a response as rate-limited (429) / credit-exhausted, or healthy (null). */
function classify(status: number, bodyText: string): "429" | "credit" | null {
  if (status === 429) return "429";
  // Some plans signal credit exhaustion via 401/403, or a JSON-RPC
  // error inside a 200. Only treat as credit when the body actually
  // says so.
  if (status === 401 || status === 403 || status === 200) {
    if (CREDIT_RE.test(bodyText)) return "credit";
  }
  return null;
}

/** Rebuild a fresh, unconsumed Response for the caller (we already read the body). */
function rebuild(resp: Response, text: string): Response {
  const nullBody =
    resp.status === 101 ||
    resp.status === 204 ||
    resp.status === 205 ||
    resp.status === 304;
  const contentType = resp.headers.get("content-type") ?? "application/json";
  return new Response(nullBody ? null : text, {
    status: resp.status,
    statusText: resp.statusText,
    headers: { "content-type": contentType },
  });
}

/**
 * Perform a Helius request through the active key, with automatic
 * failover to the other key on a rate-limit / credit-exhausted
 * response. `buildUrl(key)` embeds the chosen key into the endpoint
 * URL (RPC or REST) — the wrapper owns which key that is.
 *
 * Returns a Response whose body has NOT yet been consumed. Throws
 * `HeliusNotConfiguredError` if no key is set, or
 * `HeliusAllKeysCoolingError` if every key is cooling down.
 */
export async function heliusFetch(
  buildUrl: (apiKey: string) => string,
  init: RequestInit,
  opts: HeliusFetchOpts = {},
): Promise<Response> {
  const keys =
    opts.keys && opts.keys.length > 0 ? opts.keys : loadHeliusKeys();
  if (keys.length === 0) throw new HeliusNotConfiguredError();

  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = getLogger(opts.logger);
  const cdMs = cooldownMs();

  const tried = new Set<string>();
  let lastReason: "429" | "credit" = "429";

  // One attempt per configured key. For two keys this is exactly
  // "try, and on rate-limit switch to the other and retry once".
  while (tried.size < keys.length) {
    const now = Date.now();
    const key = keys.find((k) => !tried.has(k) && isHealthy(k, now));
    if (!key) break; // every remaining key is cooling down
    tried.add(key);

    // Fresh abort budget per attempt so a retry isn't starved by the
    // time the first attempt spent.
    let attemptInit = init;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      attemptInit = { ...init, signal: controller.signal };
    }

    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(buildUrl(key), attemptInit);
      text = await response.text();
    } finally {
      if (timer) clearTimeout(timer);
    }

    const reason = classify(response.status, text);
    if (!reason) {
      // Healthy response — hand back a fresh, re-readable Response.
      return rebuild(response, text);
    }

    // Rate-limited / credit-exhausted: cool this key down and switch.
    const coolUntil = Date.now() + cdMs;
    cooldownUntil.set(key, coolUntil);
    lastReason = reason;
    log.warn(
      {
        event: "helius_key_switch",
        key: slotLabel(keys, key),
        keyPrefix: maskKey(key),
        reason,
        upstreamStatus: response.status,
        cooldownUntil: new Date(coolUntil).toISOString(),
        ts: new Date(now).toISOString(),
      },
      `helius: ${slotLabel(keys, key)} rate-limited (${reason}) → switching key`,
    );
  }

  // No healthy key left to try.
  const now = Date.now();
  const soonest = keys.reduce(
    (min, k) => Math.min(min, cooldownUntil.get(k) ?? now),
    Number.POSITIVE_INFINITY,
  );
  const retryAfterMs = Math.max(0, (Number.isFinite(soonest) ? soonest : now) - now);
  log.error(
    {
      event: "helius_all_keys_cooling",
      keys: keys.map((k) => slotLabel(keys, k)),
      reason: lastReason,
      retryAfterMs,
      ts: new Date(now).toISOString(),
    },
    "helius: all keys cooling down — call not served",
  );
  throw new HeliusAllKeysCoolingError(lastReason, retryAfterMs);
}

/**
 * Map a heliusFetch throw to an internal-handler result. Keeps the
 * error→HTTP mapping consistent across handlers without duplicating
 * the (already centralized) switching logic. `helius_all_keys_cooling`
 * is surfaced as a 503 — a clear, logged error, not a silent drop.
 */
export function heliusErrorToResult(err: unknown): InternalHandlerResult {
  if (err instanceof HeliusAllKeysCoolingError) {
    return {
      status: 503,
      body: { error: "helius_all_keys_cooling", retryAfterMs: err.retryAfterMs },
    };
  }
  if (err instanceof HeliusNotConfiguredError) {
    return { status: 503, body: { error: "helius_not_configured" } };
  }
  return { status: 502, body: { error: "helius_unreachable" } };
}

/** Test-only: clear per-key cooldown state between cases. */
export function __resetHeliusFailoverState(): void {
  cooldownUntil.clear();
}
