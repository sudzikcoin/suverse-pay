/**
 * Fastify app for the self-serve proxy. Boot-time-only Postgres pool
 * + Redis client + master encryption key. The actual per-request
 * logic lives in handler.ts so tests can drive it directly.
 */

import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { SuverseClient } from "@suverselabs/x402-client";
import { handle, type HandleDeps } from "./handler.js";
import { CatalogBazaarStore, ProxyConfigStore } from "./store.js";
import type { ServiceAddresses } from "./upstream-x402.js";

export interface BuildServerArgs {
  pool: Pool;
  masterKey: Buffer;
  facilitatorUrl: string;
  facilitatorApiKey: string;
  /** Redis URL for the rate limiter. Optional — falls back to in-memory. */
  redisUrl?: string | undefined;
  /** Per-IP per-minute cap for the public /v1/proxy/... routes. */
  rateLimitPerMin?: number;
  /** Allow tests to inject a config store with a custom TTL. */
  store?: ProxyConfigStore;
  /**
   * Catalog metadata store for the bazaar discovery extension.
   * Optional — tests may omit it to keep the 402 challenge
   * extension-free, matching the behavior when no approved listing
   * exists for the endpoint URL.
   */
  catalogStore?: CatalogBazaarStore;
  /** Injection seam for tests — replaces global fetch. */
  fetchImpl?: typeof fetch;
  /** Pre-charge upstream health probe budget (ms). Default 3000. */
  healthCheckTimeoutMs?: number;
  /** Buyer-side client for upstream-x402 wrapping (optional). */
  upstreamX402Client?: SuverseClient;
  upstreamServiceAddresses?: ServiceAddresses;
}

export async function buildServer(
  args: BuildServerArgs,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env["LOG_LEVEL"] ?? "info" },
    bodyLimit: 1_048_576, // 1 MiB cap on inbound — proxies serve APIs, not file uploads
    trustProxy: true,
  });

  // Treat ALL bodies as raw Buffers — we forward to the upstream
  // unmodified, so JSON parsing would be wasted work (and would
  // corrupt non-JSON payloads).
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  const store = args.store ?? new ProxyConfigStore(args.pool);
  const catalogStore = args.catalogStore ?? new CatalogBazaarStore(args.pool);
  const deps: HandleDeps = {
    store,
    catalogStore,
    pool: args.pool,
    masterKey: args.masterKey,
    facilitatorUrl: args.facilitatorUrl,
    facilitatorApiKey: args.facilitatorApiKey,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    ...(args.healthCheckTimeoutMs !== undefined
      ? { healthCheckTimeoutMs: args.healthCheckTimeoutMs }
      : {}),
    ...(args.upstreamX402Client !== undefined
      ? { upstreamX402Client: args.upstreamX402Client }
      : {}),
    ...(args.upstreamServiceAddresses !== undefined
      ? { upstreamServiceAddresses: args.upstreamServiceAddresses }
      : {}),
    logger: app.log as unknown as HandleDeps["logger"],
  };

  const redisInstance = args.redisUrl ? await makeRedis(args.redisUrl) : null;
  await app.register(rateLimit, {
    max: args.rateLimitPerMin ?? 120,
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      // Bucket per (slug, IP) — one noisy IP on slug A doesn't
      // throttle slug B for everyone else on that IP. Covers both
      // legacy /v1/proxy/<reskey>/<slug> (resourceKeyId+slug) and
      // /v1/data/<public_slug> (publicSlug) param shapes.
      const params = req.params as {
        resourceKeyId?: string;
        slug?: string;
        publicSlug?: string;
      };
      const slugPart =
        params.publicSlug !== undefined
          ? `pub/${params.publicSlug}`
          : `${params.resourceKeyId ?? "_"}/${params.slug ?? "_"}`;
      return `${slugPart}::${req.ip}`;
    },
    errorResponseBuilder: (_req, ctx) => ({
      // statusCode + code in the body — both are recognised by
      // @fastify/rate-limit and propagated onto the reply. Without
      // either, Fastify falls back to 500 because the plugin throws
      // a generic Error.
      statusCode: 429,
      error: "rate_limited",
      message: "rate_limited",
      retryAfterSeconds: Math.ceil(ctx.ttl / 1000),
    }),
    ...(redisInstance ? { redis: redisInstance } : {}),
  });

  app.get("/health", async () => ({ status: "ok", service: "proxy" }));

  // Five methods, one handler. POST/PUT/PATCH/DELETE are explicit so
  // Fastify routes them; the handler itself reads `args.method`.
  for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"] as const) {
    app.route({
      method,
      url: "/v1/proxy/:resourceKeyId/:slug",
      handler: async (req, reply) => {
        const params = req.params as { resourceKeyId: string; slug: string };
        const headers = flattenHeaders(req.headers);
        const paymentHeader =
          headers["payment-signature"] ?? headers["x-payment"];
        const idempotencyKey = headers["idempotency-key"];
        const result = await handle(
          {
            resourceKeyId: params.resourceKeyId,
            slug: params.slug,
            method,
            resourceUrl: buildResourceUrl(req as unknown as RequestLike),
            paymentHeader,
            idempotencyKey,
            incomingHeaders: headers,
            body: Buffer.isBuffer(req.body) ? req.body : null,
            clientIp: req.ip ?? null,
          },
          deps,
        );
        for (const [name, value] of Object.entries(result.headers)) {
          reply.header(name, value);
        }
        return reply.code(result.status).send(result.body);
      },
    });
  }

  // /v1/data/<public_slug> — the CDP-friendly clean URL. Resolves the
  // public_slug to the spc row, then runs the same handle() pipeline as
  // the legacy /v1/proxy/<reskey>/<slug>. 404 if no row matches.
  for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"] as const) {
    app.route({
      method,
      url: "/v1/data/:publicSlug",
      handler: async (req, reply) => {
        const params = req.params as { publicSlug: string };
        const config = await deps.store.lookupByPublicSlug(params.publicSlug);
        if (config === null || !config.isActive) {
          return reply.code(404).send({ error: "unknown_endpoint" });
        }
        const headers = flattenHeaders(req.headers);
        const paymentHeader =
          headers["payment-signature"] ?? headers["x-payment"];
        const idempotencyKey = headers["idempotency-key"];
        const result = await handle(
          {
            resourceKeyId: config.resourceKeyId,
            slug: config.endpointSlug,
            method,
            resourceUrl: buildResourceUrl(req as unknown as RequestLike),
            paymentHeader,
            idempotencyKey,
            incomingHeaders: headers,
            body: Buffer.isBuffer(req.body) ? req.body : null,
            clientIp: req.ip ?? null,
          },
          deps,
        );
        for (const [name, value] of Object.entries(result.headers)) {
          reply.header(name, value);
        }
        return reply.code(result.status).send(result.body);
      },
    });
  }

  return app;
}

function flattenHeaders(
  h: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(h)) {
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? value[0] ?? "" : value;
  }
  return out;
}

interface RequestLike {
  protocol: string;
  headers: Record<string, string | string[] | undefined>;
  url: string;
}

function buildResourceUrl(req: RequestLike): string {
  // Highest precedence: explicit X-Original-URL set by an upstream
  // reverse-proxy that's fronting a "clean" URL (no query-string
  // tokens, no internal /v1/proxy/<reskey>/<slug> shape that CDP's
  // bazaar crawler may filter out as session-token-looking).
  const xou = req.headers["x-original-url"];
  const original =
    typeof xou === "string" ? xou : Array.isArray(xou) ? xou[0] : undefined;
  if (original && /^https?:\/\//.test(original)) return original;

  const xfProto = req.headers["x-forwarded-proto"];
  const proto =
    (typeof xfProto === "string" ? xfProto : Array.isArray(xfProto) ? xfProto[0] : undefined) ||
    req.protocol ||
    "https";
  const xfHost = req.headers["x-forwarded-host"];
  const host =
    (typeof xfHost === "string" ? xfHost : Array.isArray(xfHost) ? xfHost[0] : undefined) ||
    (req.headers["host"] as string | undefined) ||
    "proxy.suverse.io";
  let url = req.url || "";
  if (host === "api.suverse.io" && url.startsWith("/v1/proxy/")) {
    url = `/x402${url.slice("/v1/proxy".length)}`;
  }
  return `${proto}://${host}${url}`;
}

/**
 * Lazy Redis import — kept dynamic so tests that pass `redisUrl=undefined`
 * never touch `ioredis` and the package boots clean in pure-ESM mode.
 */
async function makeRedis(url: string): Promise<unknown> {
  const mod = (await import("ioredis")) as {
    default?: unknown;
    Redis?: unknown;
  };
  const Ctor = (mod.default ?? mod.Redis ?? mod) as new (url: string) => unknown;
  return new Ctor(url);
}
