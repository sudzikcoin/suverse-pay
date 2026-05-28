import type { Redis } from "ioredis";

/**
 * Sliding-window rate limiter for /facilitator/settle, keyed by
 * resource API key id.
 *
 * Window strategy: two 60-second buckets summed. On each request,
 * increment the CURRENT bucket and sum (current + previous). If the
 * sum exceeds the per-key limit, reject with 429. Buckets expire
 * after 120s, so storage stays bounded regardless of key count.
 *
 * Atomicity: we use a Redis pipeline (no MULTI required — the only
 * race-sensitive op is INCR which is single-key atomic). The summed
 * read is then a separate GET per bucket; in the worst case we
 * undercount by one in-flight request, which is acceptable for a
 * sliding window that's already an approximation.
 */
export interface RateLimitDeps {
  redis: Pick<Redis, "incr" | "expire" | "get" | "pipeline">;
  /** Override "now" for tests. */
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Current sum across the sliding window. */
  used: number;
  /** Configured limit. */
  limit: number;
  /** Seconds the caller should wait before retrying (0 when allowed). */
  retryAfterSeconds: number;
}

export class FacilitatorRateLimiter {
  private readonly redis: RateLimitDeps["redis"];
  private readonly now: () => number;

  constructor(deps: RateLimitDeps) {
    this.redis = deps.redis;
    this.now = deps.now ?? Date.now;
  }

  async check(args: {
    resourceKeyId: string;
    perMinuteLimit: number;
  }): Promise<RateLimitDecision> {
    const nowMs = this.now();
    const currentBucket = Math.floor(nowMs / 60_000);
    const previousBucket = currentBucket - 1;
    const currentKey = bucketKey(args.resourceKeyId, currentBucket);
    const previousKey = bucketKey(args.resourceKeyId, previousBucket);

    // Increment + set TTL for current bucket in one round trip.
    const pipeline = this.redis.pipeline();
    pipeline.incr(currentKey);
    pipeline.expire(currentKey, 120);
    pipeline.get(previousKey);
    const results = await pipeline.exec();
    if (results === null) {
      // Pipeline aborted (cluster failover, etc.). Fail open — better
      // to allow one extra request than to lock everyone out.
      return {
        allowed: true,
        used: 0,
        limit: args.perMinuteLimit,
        retryAfterSeconds: 0,
      };
    }
    const currentCount = Number(results[0]?.[1] ?? 0);
    const previousCount = Number(results[2]?.[1] ?? 0);
    // Linear interpolation gives more accurate sliding-window
    // behaviour than just summing whole buckets.
    const elapsedInCurrent = (nowMs % 60_000) / 60_000;
    const weightedPrevious = previousCount * (1 - elapsedInCurrent);
    const used = currentCount + weightedPrevious;

    if (used <= args.perMinuteLimit) {
      return {
        allowed: true,
        used: Math.floor(used),
        limit: args.perMinuteLimit,
        retryAfterSeconds: 0,
      };
    }
    // Caller should wait until the next minute boundary at minimum.
    const msUntilNextBucket = 60_000 - (nowMs % 60_000);
    return {
      allowed: false,
      used: Math.floor(used),
      limit: args.perMinuteLimit,
      retryAfterSeconds: Math.ceil(msUntilNextBucket / 1000),
    };
  }
}

function bucketKey(resourceKeyId: string, bucket: number): string {
  return `facilitator:ratelimit:${resourceKeyId}:${bucket}`;
}
