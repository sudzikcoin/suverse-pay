import { describe, expect, it } from "vitest";
import {
  SELF_WALLETS,
  periodToSince,
} from "../src/lib/dashboard-aggregates";

describe("dashboard-aggregates · periodToSince", () => {
  const now = new Date("2026-05-29T12:00:00Z");

  it("24h subtracts 24 hours", () => {
    expect(periodToSince("24h", now)!.toISOString()).toBe(
      "2026-05-28T12:00:00.000Z",
    );
  });

  it("7d subtracts 7 days", () => {
    expect(periodToSince("7d", now)!.toISOString()).toBe(
      "2026-05-22T12:00:00.000Z",
    );
  });

  it("30d subtracts 30 days", () => {
    expect(periodToSince("30d", now)!.toISOString()).toBe(
      "2026-04-29T12:00:00.000Z",
    );
  });

  it("'all' returns null — caller must not apply a time bound", () => {
    expect(periodToSince("all", now)).toBeNull();
  });
});

describe("dashboard-aggregates · SELF_WALLETS", () => {
  it("matches the test wallets called out in the design doc", () => {
    expect(SELF_WALLETS).toContain(
      "0x3869dE7597bDEa0172B97143f3eed806D8b84bf3",
    );
    expect(SELF_WALLETS).toContain(
      "26edvkZ99Lfs6LEwfSbfbJG17NM6z4BqrWMk7Z8hTe4D",
    );
  });

  it("contains no duplicates", () => {
    expect(SELF_WALLETS.length).toBe(new Set(SELF_WALLETS).size);
  });
});
