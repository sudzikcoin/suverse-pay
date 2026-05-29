import { describe, expect, it } from "vitest";
import { periodToSince } from "../src/lib/queries";

describe("periodToSince", () => {
  const now = new Date("2026-05-29T12:00:00Z");

  it("24h period subtracts 24 hours", () => {
    const since = periodToSince("24h", now);
    expect(since.toISOString()).toBe("2026-05-28T12:00:00.000Z");
  });

  it("7d period subtracts 7 days", () => {
    const since = periodToSince("7d", now);
    expect(since.toISOString()).toBe("2026-05-22T12:00:00.000Z");
  });

  it("30d period subtracts 30 days", () => {
    const since = periodToSince("30d", now);
    expect(since.toISOString()).toBe("2026-04-29T12:00:00.000Z");
  });
});
