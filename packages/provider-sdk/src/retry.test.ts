import { ProviderError } from "@suverse-pay/core-types";
import { describe, expect, it, vi } from "vitest";
import { computeBackoff, withRetry } from "./retry.js";

const noSleep = (_ms: number): Promise<void> => Promise.resolve();

describe("withRetry", () => {
  it("returns the value when the first attempt succeeds", async () => {
    const fn = vi.fn(async () => "ok");
    const result = await withRetry(fn, { maxAttempts: 3, sleep: noSleep });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable ProviderError and eventually succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw new ProviderError("network_error", "blip");
      }
      return "ok";
    });
    const result = await withRetry(fn, { maxAttempts: 5, sleep: noSleep });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on non-retryable ProviderError", async () => {
    const fn = vi.fn(async () => {
      throw new ProviderError("invalid_signature", "bad sig");
    });
    await expect(withRetry(fn, { maxAttempts: 5, sleep: noSleep })).rejects.toMatchObject({
      code: "invalid_signature",
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on non-ProviderError exceptions", async () => {
    const fn = vi.fn(async () => {
      throw new Error("plain js error");
    });
    await expect(withRetry(fn, { maxAttempts: 5, sleep: noSleep })).rejects.toThrow(
      /plain js error/,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts and throws the last retryable error", async () => {
    const fn = vi.fn(async () => {
      throw new ProviderError("rate_limited", "still throttled");
    });
    await expect(withRetry(fn, { maxAttempts: 3, sleep: noSleep })).rejects.toMatchObject({
      code: "rate_limited",
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("rejects maxAttempts < 1", async () => {
    await expect(withRetry(() => Promise.resolve(1), { maxAttempts: 0 })).rejects.toThrow(
      /maxAttempts must be >= 1/,
    );
  });

  it("passes the attempt number to the worker", async () => {
    const seen: number[] = [];
    let calls = 0;
    await withRetry(
      async (attempt) => {
        seen.push(attempt);
        calls += 1;
        if (calls < 3) throw new ProviderError("timeout", "x");
        return "done";
      },
      { maxAttempts: 5, sleep: noSleep },
    );
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe("computeBackoff", () => {
  it("exponentially increases without jitter", () => {
    expect(computeBackoff(1, 100, 10_000, false)).toBe(100);
    expect(computeBackoff(2, 100, 10_000, false)).toBe(200);
    expect(computeBackoff(3, 100, 10_000, false)).toBe(400);
    expect(computeBackoff(4, 100, 10_000, false)).toBe(800);
  });

  it("clamps at maxDelayMs", () => {
    expect(computeBackoff(20, 100, 1_000, false)).toBe(1_000);
  });

  it("with jitter, returns a value in [0.5 * expo, expo]", () => {
    const randFloor = (): number => 0;
    const randCeil = (): number => 0.9999999;
    expect(computeBackoff(1, 100, 10_000, true, randFloor)).toBe(50);
    expect(computeBackoff(1, 100, 10_000, true, randCeil)).toBe(99);
  });
});
