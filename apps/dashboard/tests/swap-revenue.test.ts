import { describe, expect, it } from "vitest";
import {
  SWAP_QUOTE_FEE_ATOMIC,
  computeSwapRevenue,
  isSwapHandler,
} from "../src/lib/proxy-config-store";

describe("computeSwapRevenue", () => {
  it("quote fees = totalQuotes × $0.001 atomic", () => {
    expect(SWAP_QUOTE_FEE_ATOMIC).toBe(1000n);
    const r = computeSwapRevenue({ totalQuotes: 7, swapFeesAtomic: "0" });
    expect(r.quoteFeesAtomic).toBe("7000");
    expect(r.swapFeesAtomic).toBe("0");
    expect(r.totalRevenueAtomic).toBe("7000");
  });

  it("total = quote + swap fees", () => {
    const r = computeSwapRevenue({
      totalQuotes: 12,
      swapFeesAtomic: "55000",
    });
    expect(r.quoteFeesAtomic).toBe("12000");
    expect(r.swapFeesAtomic).toBe("55000");
    expect(r.totalRevenueAtomic).toBe("67000");
  });

  it("handles large bigint sums without overflow", () => {
    const r = computeSwapRevenue({
      totalQuotes: 1_000_000,
      swapFeesAtomic: "9999999999999",
    });
    expect(r.quoteFeesAtomic).toBe("1000000000");
    expect(r.totalRevenueAtomic).toBe("10000999999999");
  });

  it("treats unparseable swapFeesAtomic as zero", () => {
    const r = computeSwapRevenue({
      totalQuotes: 3,
      swapFeesAtomic: "not-a-number",
    });
    expect(r.swapFeesAtomic).toBe("0");
    expect(r.totalRevenueAtomic).toBe("3000");
  });

  it("zero quotes → zero quote fees", () => {
    const r = computeSwapRevenue({ totalQuotes: 0, swapFeesAtomic: "42" });
    expect(r.quoteFeesAtomic).toBe("0");
    expect(r.totalRevenueAtomic).toBe("42");
  });
});

describe("isSwapHandler", () => {
  it("recognizes the two swap handler IDs", () => {
    expect(isSwapHandler("swap_solana_execute")).toBe(true);
    expect(isSwapHandler("swap_base_execute")).toBe(true);
  });

  it("rejects regular proxy handlers and nulls", () => {
    expect(isSwapHandler("oatp_forward")).toBe(false);
    expect(isSwapHandler(null)).toBe(false);
    expect(isSwapHandler("")).toBe(false);
  });
});
