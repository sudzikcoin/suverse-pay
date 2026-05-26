import { describe, expect, it } from "vitest";
import { InMemoryUsageTracker } from "./usage-tracker.js";

describe("InMemoryUsageTracker", () => {
  it("starts at zero by default", async () => {
    const t = new InMemoryUsageTracker();
    expect(await t.current()).toBe(0);
  });

  it("starts at the supplied initial count", async () => {
    const t = new InMemoryUsageTracker(42);
    expect(await t.current()).toBe(42);
  });

  it("increment() adds one each call", async () => {
    const t = new InMemoryUsageTracker();
    await t.increment();
    await t.increment();
    await t.increment();
    expect(await t.current()).toBe(3);
  });

  it("reset() clears to zero", async () => {
    const t = new InMemoryUsageTracker(99);
    await t.reset();
    expect(await t.current()).toBe(0);
  });
});
