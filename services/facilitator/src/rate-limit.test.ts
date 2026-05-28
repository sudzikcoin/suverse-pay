import { describe, expect, it } from "vitest";
import { FacilitatorRateLimiter } from "./rate-limit.js";

interface FakePipelineResult {
  values: Array<[Error | null, unknown]>;
}

/**
 * In-memory stand-in for the ioredis subset the limiter needs. Each
 * bucket key tracks its own integer counter; `pipeline()` returns a
 * thenable whose `.exec()` returns the standard [err, value] tuples.
 */
function makeFakeRedis(initial: Record<string, number> = {}): {
  redis: Parameters<typeof makeLimiter>[0];
  state: Record<string, number>;
} {
  const state: Record<string, number> = { ...initial };
  type Cmd = ["incr", string] | ["expire", string, number] | ["get", string];
  const redis = {
    async incr(key: string): Promise<number> {
      state[key] = (state[key] ?? 0) + 1;
      return state[key]!;
    },
    async expire(_key: string, _seconds: number): Promise<number> {
      return 1;
    },
    async get(key: string): Promise<string | null> {
      const v = state[key];
      return v === undefined ? null : String(v);
    },
    pipeline(): {
      incr: (k: string) => unknown;
      expire: (k: string, n: number) => unknown;
      get: (k: string) => unknown;
      exec: () => Promise<FakePipelineResult["values"] | null>;
    } {
      const cmds: Cmd[] = [];
      const proxy = {
        incr(k: string): typeof proxy {
          cmds.push(["incr", k]);
          return proxy;
        },
        expire(k: string, n: number): typeof proxy {
          cmds.push(["expire", k, n]);
          return proxy;
        },
        get(k: string): typeof proxy {
          cmds.push(["get", k]);
          return proxy;
        },
        async exec(): Promise<FakePipelineResult["values"] | null> {
          const out: FakePipelineResult["values"] = [];
          for (const c of cmds) {
            if (c[0] === "incr") {
              state[c[1]] = (state[c[1]] ?? 0) + 1;
              out.push([null, state[c[1]]!]);
            } else if (c[0] === "expire") {
              out.push([null, 1]);
            } else {
              const v = state[c[1]];
              out.push([null, v === undefined ? null : String(v)]);
            }
          }
          return out;
        },
      };
      return proxy;
    },
  };
  return { redis, state };
}

function makeLimiter(
  redis: {
    incr: (k: string) => Promise<number>;
    expire: (k: string, n: number) => Promise<number>;
    get: (k: string) => Promise<string | null>;
    pipeline: () => unknown;
  },
  now: number,
): FacilitatorRateLimiter {
  return new FacilitatorRateLimiter({
    redis: redis as never,
    now: () => now,
  });
}

// Pinned to an exact minute boundary so `T % 60_000 === 0` — the
// interpolation arithmetic depends on the offset within the minute.
const T = Math.ceil(1_700_000_000_000 / 60_000) * 60_000;

describe("FacilitatorRateLimiter", () => {
  it("allows the first request, increments the counter", async () => {
    const { redis, state } = makeFakeRedis();
    const limiter = makeLimiter(redis, T);
    const decision = await limiter.check({ resourceKeyId: "reskey_a", perMinuteLimit: 60 });
    expect(decision.allowed).toBe(true);
    expect(decision.used).toBe(1);
    expect(decision.limit).toBe(60);
    expect(decision.retryAfterSeconds).toBe(0);
    expect(Object.values(state).reduce((s, n) => s + n, 0)).toBe(1);
  });

  it("rejects once the per-minute limit is exhausted in the current bucket", async () => {
    const currentBucket = Math.floor(T / 60_000);
    const currentKey = `facilitator:ratelimit:reskey_b:${currentBucket}`;
    // 60 requests already counted in the current bucket. The 61st
    // INCR brings the count to 61, exceeding the limit of 60.
    const { redis } = makeFakeRedis({ [currentKey]: 60 });
    const limiter = makeLimiter(redis, T);
    const decision = await limiter.check({ resourceKeyId: "reskey_b", perMinuteLimit: 60 });
    expect(decision.allowed).toBe(false);
    expect(decision.used).toBe(61);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("uses linear interpolation across the previous bucket — half-elapsed minute counts half the previous bucket", async () => {
    // 30s into the current minute → previous bucket weighted 0.5.
    const halfwayThroughMinute = T + 30_000;
    const previousBucket = Math.floor(halfwayThroughMinute / 60_000) - 1;
    const previousKey = `facilitator:ratelimit:reskey_c:${previousBucket}`;
    // Previous bucket has 40 requests; weighted 0.5 → 20 carryover.
    // Current bucket starts at 0; INCR brings it to 1. Total = 21 ≤ 60.
    const { redis } = makeFakeRedis({ [previousKey]: 40 });
    const limiter = makeLimiter(redis, halfwayThroughMinute);
    const decision = await limiter.check({ resourceKeyId: "reskey_c", perMinuteLimit: 60 });
    expect(decision.allowed).toBe(true);
    expect(decision.used).toBe(21);
  });

  it("each resource key has its own counter (no cross-tenant interference)", async () => {
    const { redis } = makeFakeRedis();
    const limiter = makeLimiter(redis, T);
    // Burn through key A's quota.
    for (let i = 0; i < 5; i += 1) {
      await limiter.check({ resourceKeyId: "reskey_A", perMinuteLimit: 5 });
    }
    // A's 6th call rejects.
    const rejected = await limiter.check({ resourceKeyId: "reskey_A", perMinuteLimit: 5 });
    expect(rejected.allowed).toBe(false);
    // B's 1st call allowed — completely independent counter.
    const allowed = await limiter.check({ resourceKeyId: "reskey_B", perMinuteLimit: 5 });
    expect(allowed.allowed).toBe(true);
    expect(allowed.used).toBe(1);
  });
});
