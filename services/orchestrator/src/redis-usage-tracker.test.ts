import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error — ioredis-mock has no published types
import IORedisMock from "ioredis-mock";
import type Redis from "ioredis";
import { RedisUsageTracker } from "./redis-usage-tracker.js";

let redis: Redis;

beforeEach(async () => {
  redis = new IORedisMock();
  await redis.flushall(); // ioredis-mock shares state across instances by default
});

afterEach(async () => {
  await redis.quit();
});

describe("RedisUsageTracker", () => {
  it("starts at zero", async () => {
    const t = new RedisUsageTracker(redis);
    expect(await t.current()).toBe(0);
  });

  it("increment() bumps the counter", async () => {
    const t = new RedisUsageTracker(redis);
    await t.increment();
    await t.increment();
    await t.increment();
    expect(await t.current()).toBe(3);
  });

  it("buckets by UTC calendar month — different months get separate keys", async () => {
    const may = new Date("2026-05-26T12:00:00Z");
    const june = new Date("2026-06-01T00:00:01Z");
    let now: Date = may;
    const t = new RedisUsageTracker(redis, "cdp:usage", () => now);

    await t.increment();
    await t.increment();
    expect(await t.current()).toBe(2);

    // Flip to June — fresh bucket.
    now = june;
    expect(await t.current()).toBe(0);

    await t.increment();
    expect(await t.current()).toBe(1);

    // May bucket is still intact.
    now = may;
    expect(await t.current()).toBe(2);
  });

  it("reset() clears only the current bucket", async () => {
    const t = new RedisUsageTracker(redis);
    await t.increment();
    await t.increment();
    await t.reset();
    expect(await t.current()).toBe(0);
  });

  it("sets a TTL on the first increment so the key auto-expires", async () => {
    const t = new RedisUsageTracker(redis, "cdp:usage", () => new Date("2026-05-26T00:00:00Z"));
    await t.increment();
    const ttl = await redis.ttl("cdp:usage:2026-05");
    expect(ttl).toBeGreaterThan(30 * 24 * 60 * 60); // > 30 days
  });

  it("respects a custom key prefix", async () => {
    const t = new RedisUsageTracker(
      redis,
      "custom:prefix",
      () => new Date("2026-05-26T00:00:00Z"),
    );
    await t.increment();
    const v = await redis.get("custom:prefix:2026-05");
    expect(v).toBe("1");
  });
});
