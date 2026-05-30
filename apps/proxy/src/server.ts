/**
 * Fastify app for the self-serve proxy. Boot-time-only Postgres pool
 * + Redis client + master encryption key. The actual per-request
 * logic lives in handler.ts so tests can drive it directly.
 */

import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { handle, type HandleDeps } from "./handler.js";
import { ProxyConfigStore } from "./store.js";

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
  /** Injection seam for tests — replaces global fetch. */
  fetchImpl?: typeof fetch;
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
  const deps: HandleDeps = {
    store,
    pool: args.pool,
    masterKey: args.masterKey,
    facilitatorUrl: args.facilitatorUrl,
    facilitatorApiKey: args.facilitatorApiKey,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    logger: app.log as unknown as HandleDeps["logger"],
  };

  const redisInstance = args.redisUrl ? await makeRedis(args.redisUrl) : null;
  await app.register(rateLimit, {
    max: args.rateLimitPerMin ?? 120,
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      // Bucket per (slug, IP) — one noisy IP on slug A doesn't
      // throttle slug B for everyone else on that IP.
      const params = req.params as { resourceKeyId?: string; slug?: string };
      const slugPart = `${params.resourceKeyId ?? "_"}/${params.slug ?? "_"}`;
      return `${slugPart}::${req.ip}`;
    },
    errorResponseBuilder: (_req, ctx) => ({
      error: "rate_limited",
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
  const proto = req.protocol || "https";
  const host =
    (req.headers["host"] as string | undefined) ?? "proxy.suverse.io";
  return `${proto}://${host}${req.url}`;
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
