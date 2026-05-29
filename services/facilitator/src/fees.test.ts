import { describe, expect, it } from "vitest";
import {
  MAX_FEE_USDC_ATOMIC,
  MIN_FEE_ATOMIC,
  computeFee,
} from "./fees.js";

describe("computeFee — typical cases", () => {
  it("30 bps on $1 USDC = $0.003 fee, $0.997 net", () => {
    // $1 USDC = 1_000_000 atomic (6 decimals)
    const r = computeFee(1_000_000n, 30);
    expect(r.gross).toBe(1_000_000n);
    expect(r.fee).toBe(3_000n);
    expect(r.net).toBe(997_000n);
    expect(r.fee + r.net).toBe(r.gross);
  });

  it("0 bps disables the fee entirely (backwards-compat)", () => {
    const r = computeFee(1_000_000n, 0);
    expect(r).toEqual({ gross: 1_000_000n, fee: 0n, net: 1_000_000n });
  });

  it("1000 bps (10%) on $0.01 = $0.001 fee, $0.009 net", () => {
    // $0.01 = 10_000 atomic
    const r = computeFee(10_000n, 1000);
    expect(r.fee).toBe(1_000n);
    expect(r.net).toBe(9_000n);
  });
});

describe("computeFee — floor (MIN_FEE_ATOMIC = 1)", () => {
  it("30 bps on $0.0003 (300 atomic) → computed 0, bumped to 1 atomic floor", () => {
    const r = computeFee(300n, 30);
    // 300 * 30 / 10000 = 0 (integer truncation) → floor kicks in
    expect(r.fee).toBe(MIN_FEE_ATOMIC); // 1n
    expect(r.net).toBe(299n);
  });

  it("gross = 1 atomic — nothing to split, fee stays 0, merchant keeps the atom", () => {
    const r = computeFee(1n, 30);
    expect(r).toEqual({ gross: 1n, fee: 0n, net: 1n });
  });

  it("gross = 2 atomic with floor = 1 → fee = 1, net = 1", () => {
    const r = computeFee(2n, 30);
    expect(r.fee).toBe(1n);
    expect(r.net).toBe(1n);
  });
});

describe("computeFee — cap (MAX_FEE_USDC_ATOMIC = $1)", () => {
  it("30 bps on $10000 USDC → fee = $1 cap, not $30", () => {
    // $10000 = 10_000_000_000 atomic
    const r = computeFee(10_000_000_000n, 30);
    expect(r.fee).toBe(MAX_FEE_USDC_ATOMIC); // 1_000_000n = $1
    expect(r.net).toBe(9_999_000_000n);
  });

  it("1000 bps (10%) on $1000 USDC → fee = $1 cap, not $100", () => {
    // $1000 = 1_000_000_000 atomic
    const r = computeFee(1_000_000_000n, 1000);
    expect(r.fee).toBe(MAX_FEE_USDC_ATOMIC);
  });
});

describe("computeFee — invariant gross = fee + net (fuzz)", () => {
  const cases: Array<[bigint, number]> = [
    [1n, 30],
    [2n, 30],
    [100n, 30],
    [10_000n, 50],
    [123_456n, 17],
    [999_999_999n, 30],
    [1_000_000_000n, 1000],
    [1n, 0],
    [1_000_000n, 0],
  ];
  for (const [gross, bps] of cases) {
    it(`gross=${gross}, bps=${bps}: gross === fee + net`, () => {
      const r = computeFee(gross, bps);
      expect(r.gross).toBe(gross);
      expect(r.fee + r.net).toBe(gross);
      expect(r.fee).toBeGreaterThanOrEqual(0n);
      expect(r.net).toBeGreaterThanOrEqual(0n);
    });
  }
});

describe("computeFee — input validation", () => {
  it("rejects negative gross", () => {
    expect(() => computeFee(-1n, 30)).toThrow(RangeError);
  });

  it("rejects feeBps out of range (1001)", () => {
    expect(() => computeFee(1_000_000n, 1001)).toThrow(RangeError);
  });

  it("rejects negative feeBps", () => {
    expect(() => computeFee(1_000_000n, -1)).toThrow(RangeError);
  });

  it("rejects non-integer feeBps", () => {
    expect(() => computeFee(1_000_000n, 30.5)).toThrow(RangeError);
  });
});
