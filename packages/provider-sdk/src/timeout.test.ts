import { ProviderError } from "@suverse-pay/core-types";
import { describe, expect, it } from "vitest";
import { withTimeout } from "./timeout.js";

describe("withTimeout", () => {
  it("resolves when the inner promise finishes before timeout", async () => {
    const result = await withTimeout(Promise.resolve(42), 100);
    expect(result).toBe(42);
  });

  it("rejects with ProviderError('timeout') when the deadline is hit first", async () => {
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 100));
    await expect(withTimeout(slow, 20)).rejects.toMatchObject({
      name: "ProviderError",
      code: "timeout",
    });
  });

  it("propagates the inner rejection when it loses to the deadline race", async () => {
    const fast = Promise.reject(new Error("inner fail"));
    await expect(withTimeout(fast, 100)).rejects.toThrow(/inner fail/);
  });

  it("attaches providerId on the timeout error", async () => {
    const slow = new Promise<void>((resolve) => setTimeout(resolve, 100));
    try {
      await withTimeout(slow, 5, { providerId: "cosmos-pay" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).providerId).toBe("cosmos-pay");
    }
  });
});
