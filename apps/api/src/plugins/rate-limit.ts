import fastifyRateLimit from "@fastify/rate-limit";
import type { Redis } from "ioredis";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.js";

/**
 * Per-api-key sliding-window rate limit. Backed by Redis so the limit
 * is consistent across multiple API replicas. Falls back to in-memory
 * if `redis` is null (tests / dev without a Redis up).
 */
export interface RateLimitOptions {
  config: Config;
  redis: Redis | null;
}

export async function registerRateLimit(
  app: FastifyInstance,
  opts: RateLimitOptions,
): Promise<void> {
  await app.register(fastifyRateLimit, {
    max: opts.config.rateLimitMaxPerMinute,
    timeWindow: "1 minute",
    redis: opts.redis ?? undefined,
    keyGenerator: (req: FastifyRequest) =>
      req.apiKeyId ?? req.ip ?? "anonymous",
    skipOnError: true, // If Redis is flapping, don't lock everyone out.
    errorResponseBuilder: (_req, ctx) => ({
      error: {
        code: "rate_limited",
        message: `rate limit exceeded; try again in ${Math.ceil(
          ctx.ttl / 1000,
        )}s`,
      },
    }),
  });
}
