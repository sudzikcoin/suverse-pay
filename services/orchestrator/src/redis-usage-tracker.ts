import type { UsageTracker } from "@suverse-pay/adapter-coinbase-cdp";
import type { Redis } from "ioredis";

const DEFAULT_KEY_PREFIX = "cdp:usage";
/** Slightly more than a month so the key survives month-boundary races. */
const KEY_TTL_SECONDS = 35 * 24 * 60 * 60;

/**
 * Redis-backed implementation of the UsageTracker interface that
 * `@suverse-pay/adapter-coinbase-cdp` consumes. Counts are bucketed
 * per UTC calendar month; switching months yields a fresh key, so the
 * tracker auto-resets without an explicit cron.
 *
 * Key shape: `<prefix>:YYYY-MM`. Example: `cdp:usage:2026-05`.
 */
export class RedisUsageTracker implements UsageTracker {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix: string = DEFAULT_KEY_PREFIX,
    /** Override for tests. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  private currentKey(): string {
    const d = this.now();
    const yyyy = d.getUTCFullYear();
    const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
    return `${this.keyPrefix}:${yyyy}-${mm}`;
  }

  async current(): Promise<number> {
    const v = await this.redis.get(this.currentKey());
    return v === null ? 0 : Number.parseInt(v, 10);
  }

  async increment(): Promise<void> {
    const key = this.currentKey();
    const next = await this.redis.incr(key);
    if (next === 1) {
      // Set TTL exactly once on first increment.
      await this.redis.expire(key, KEY_TTL_SECONDS);
    }
  }

  async reset(): Promise<void> {
    await this.redis.del(this.currentKey());
  }
}
