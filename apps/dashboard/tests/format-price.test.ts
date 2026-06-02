import { describe, expect, it } from "vitest";
import { formatAtomicUsd, formatListingPrice } from "../src/lib/format-price";

describe("formatAtomicUsd", () => {
  it("formats whole-dollar amounts with 2 decimals", () => {
    expect(formatAtomicUsd("1000000")).toBe("$1.00");
    expect(formatAtomicUsd("50000000")).toBe("$50.00");
    expect(formatAtomicUsd("1234567")).toBe("$1.23");
  });

  it("formats sub-dollar amounts with full precision, trimmed", () => {
    // $0.001 = 1_000 atomic
    expect(formatAtomicUsd("1000")).toBe("$0.001");
    // $0.0001 = 100 atomic
    expect(formatAtomicUsd("100")).toBe("$0.0001");
    // $0.01 = 10_000 atomic
    expect(formatAtomicUsd("10000")).toBe("$0.01");
  });

  it("renders zero as $0.0", () => {
    expect(formatAtomicUsd("0")).toBe("$0.0");
  });

  it("returns sentinel on non-numeric input", () => {
    expect(formatAtomicUsd("not-a-number")).toBe("$?");
  });
});

describe("formatListingPrice", () => {
  it("returns the min price when min == max (single tier)", () => {
    expect(formatListingPrice("10000", "10000")).toBe("$0.01");
    expect(formatListingPrice("1000000", "1000000")).toBe("$1.00");
  });

  it("returns only the min price when a range is provided (the max is a gas-guard ceiling, not a tier)", () => {
    // Real-world: min $0.001, max $50 → must render JUST $0.001
    expect(formatListingPrice("1000", "50000000")).toBe("$0.001");
    expect(formatListingPrice("1000", "50000000")).not.toContain("50");
    expect(formatListingPrice("1000", "50000000")).not.toContain("-");
  });

  it("works with no max provided (legacy / unknown ceiling)", () => {
    expect(formatListingPrice("5000")).toBe("$0.005");
    expect(formatListingPrice("5000", null)).toBe("$0.005");
  });
});
