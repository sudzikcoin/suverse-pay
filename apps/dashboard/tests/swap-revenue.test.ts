import { describe, expect, it } from "vitest";
import {
  SWAP_QUOTE_FEE_ATOMIC,
  computeSwapRevenue,
  isSwapHandler,
  swapRowVolumeAtomic,
} from "../src/lib/proxy-config-store";

const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

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

describe("swapRowVolumeAtomic", () => {
  it("forward (input == USDC) → input_amount as USDC", () => {
    // 1 USDC in → 5,977,180,021 BONK out
    const v = swapRowVolumeAtomic(
      {
        inputToken: USDC_SOL,
        inputAmount: "1000000",
        outputToken: BONK,
        expectedOutput: "5977180021",
      },
      USDC_SOL,
    );
    expect(v).toBe(1_000_000n);
  });

  it("reverse (output == USDC) → expected_output as USDC, not input_amount", () => {
    // 5,000,000,000,000 BONK atoms (5-dec) in → 50 USDC (50_000_000 atoms) out.
    // Bug being fixed: previously this row's input_amount got summed as
    // if it were USDC and produced trillions of fake dollars.
    const v = swapRowVolumeAtomic(
      {
        inputToken: BONK,
        inputAmount: "5000000000000",
        outputToken: USDC_SOL,
        expectedOutput: "50000000",
      },
      USDC_SOL,
    );
    expect(v).toBe(50_000_000n);
  });

  it("neither side is USDC → 0", () => {
    const v = swapRowVolumeAtomic(
      {
        inputToken: BONK,
        inputAmount: "12345",
        outputToken: "So11111111111111111111111111111111111111112",
        expectedOutput: "67890",
      },
      USDC_SOL,
    );
    expect(v).toBe(0n);
  });

  it("reverse with null expected_output → 0 (in-flight or pre-execute row)", () => {
    const v = swapRowVolumeAtomic(
      {
        inputToken: BONK,
        inputAmount: "9999999999999",
        outputToken: USDC_SOL,
        expectedOutput: null,
      },
      USDC_SOL,
    );
    expect(v).toBe(0n);
  });

  it("sum of mixed forward + reverse rows stays USDC-denominated", () => {
    const rows = [
      {
        // 1 USDC → BONK
        inputToken: USDC_SOL,
        inputAmount: "1000000",
        outputToken: BONK,
        expectedOutput: "5977180021",
      },
      {
        // BONK → 50 USDC (the row that used to blow up the total)
        inputToken: BONK,
        inputAmount: "5000000000000",
        outputToken: USDC_SOL,
        expectedOutput: "50000000",
      },
      {
        // 2 USDC → WIF
        inputToken: USDC_SOL,
        inputAmount: "2000000",
        outputToken: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
        expectedOutput: "12345",
      },
    ];
    const total = rows.reduce(
      (acc, r) => acc + swapRowVolumeAtomic(r, USDC_SOL),
      0n,
    );
    // 1 + 50 + 2 = $53 (atomic 53_000_000), not $5.2T.
    expect(total).toBe(53_000_000n);
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
