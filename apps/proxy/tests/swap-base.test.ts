/**
 * Focused unit tests for the pure helpers in swap-base.ts —
 * buildBaseQuoteResponse formatting + gas-guard field threading. The
 * orchestration (executeBaseSwap) is exercised end-to-end by the
 * swap-base-smoke script and the integration suite; we don't double-
 * cover it here.
 */

import { describe, expect, it } from "vitest";
import {
  buildBaseQuoteResponse,
  computeFee,
  MAX_INPUT_USDC_ATOMIC,
  USDC_BASE,
  validateBaseQuoteInput,
} from "../src/swap-base.js";
import type { TokenMetadata } from "../src/lib/token-metadata.js";
import type { GasGuardOk } from "../src/swap-gas-guard.js";

const USDC_META: TokenMetadata = {
  mint: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
};
const WETH_META: TokenMetadata = {
  mint: "0x4200000000000000000000000000000000000006",
  symbol: "WETH",
  name: "Wrapped Ether",
  decimals: 18,
};

describe("validateBaseQuoteInput", () => {
  it("accepts forward (USDC → WETH)", () => {
    const r = validateBaseQuoteInput({
      input_token: USDC_BASE,
      output_token: WETH_META.mint,
      input_amount: "10000000",
      slippage_bps: 100,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.req.direction).toBe("forward");
  });

  it("accepts reverse (WETH → USDC)", () => {
    const r = validateBaseQuoteInput({
      input_token: WETH_META.mint,
      output_token: USDC_BASE,
      input_amount: "500000000000000",
      slippage_bps: 100,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.req.direction).toBe("reverse");
  });

  it("rejects when neither side is USDC", () => {
    const r = validateBaseQuoteInput({
      input_token: WETH_META.mint,
      output_token: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", // AERO
      input_amount: "1000000",
      slippage_bps: 100,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("one_side_must_be_usdc");
  });

  it("forward direction enforces MAX cap pre-quote", () => {
    const r = validateBaseQuoteInput({
      input_token: USDC_BASE,
      output_token: WETH_META.mint,
      input_amount: (MAX_INPUT_USDC_ATOMIC + 1n).toString(),
      slippage_bps: 100,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("input_amount_exceeds_max");
  });

  it("reverse direction does NOT cap input pre-quote", () => {
    const r = validateBaseQuoteInput({
      input_token: WETH_META.mint,
      output_token: USDC_BASE,
      input_amount: "999999999999999999999",
      slippage_bps: 100,
    });
    expect(r.ok).toBe(true);
  });
});

describe("Base computeFee", () => {
  it("computes 1% with round-up", () => {
    expect(computeFee(1_000_000n)).toBe(10_000n);
    expect(computeFee(1_234_567n)).toBe(12_346n); // round up
  });
});

describe("buildBaseQuoteResponse", () => {
  it("emits token objects + back-compat mint aliases + x402_pay_url", () => {
    const r = buildBaseQuoteResponse({
      quoteId: "qb_xyz",
      inputMeta: USDC_META,
      outputMeta: WETH_META,
      inputAmount: 10_000_000n,
      expectedOutput: 2_500_000_000_000_000n, // 0.0025 WETH
      fee: 100_000n,
      tool: "uniswap-v3",
      expiresAt: new Date(1_900_000_000_000),
      publicBaseUrl: "https://proxy.suverse.io",
      direction: "forward",
    });
    expect(r.quote_id).toBe("qb_xyz");
    expect(r.x402_pay_url).toBe(
      "https://proxy.suverse.io/v1/swap/base/execute/qb_xyz",
    );
    expect(r.input_token).toEqual({
      mint: USDC_META.mint,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
    });
    expect(r.output_token).toEqual({
      mint: WETH_META.mint,
      symbol: "WETH",
      name: "Wrapped Ether",
      decimals: 18,
    });
    expect(r.input_token_mint).toBe(USDC_META.mint);
    expect(r.output_token_mint).toBe(WETH_META.mint);
    expect(r.tool).toBe("uniswap-v3");
    expect(r.expected_output_human).toBe("0.0025 WETH");
    expect(r.fee_human).toBe("0.1 USDC");
    expect(r.total_cost_human).toBe("10.1 USDC");
  });

  it("renders UNKNOWN output gracefully", () => {
    const unknownMeta: TokenMetadata = {
      mint: "0x" + "ab".repeat(20),
      symbol: "UNKNOWN",
      name: "long-tail",
      decimals: 0,
    };
    const r = buildBaseQuoteResponse({
      quoteId: "qb_unk",
      inputMeta: USDC_META,
      outputMeta: unknownMeta,
      inputAmount: 1_000_000n,
      expectedOutput: 12_345n,
      fee: 10_000n,
      tool: "uniswap-v3",
      expiresAt: new Date(1_900_000_000_000),
      publicBaseUrl: "https://proxy.suverse.io",
      direction: "forward",
    });
    expect(r.expected_output_human).toBe("12345 UNKNOWN");
    expect(r.output_token.decimals).toBe(0);
  });

  it("threads gas-guard fields through when supplied", () => {
    const guard: GasGuardOk = {
      ok: true,
      minimumInputAtomic: 1_100_000n,
      estimatedGasCostUsd: 0.011,
      warning:
        "LiFi router has no USDC allowance from the liquidity wallet " +
        "yet; minimum input is raised to cover the one-time approve.",
    };
    const r = buildBaseQuoteResponse({
      quoteId: "qb_guard",
      inputMeta: USDC_META,
      outputMeta: WETH_META,
      inputAmount: 5_000_000n,
      expectedOutput: 1_250_000_000_000_000n,
      fee: 50_000n,
      tool: "uniswap-v3",
      expiresAt: new Date(1_900_000_000_000),
      publicBaseUrl: "https://proxy.suverse.io",
      gasGuard: guard,
    });
    expect(r.minimum_input_atomic).toBe("1100000");
    expect(r.estimated_gas_cost_usd).toBe(0.011);
    expect(r.gas_warning).toBeDefined();
    expect(r.gas_warning).toMatch(/allowance/i);
  });

  it("reverse direction: total_cost is fee-only + requires_approval=true", () => {
    const r = buildBaseQuoteResponse({
      quoteId: "qb_rev",
      inputMeta: WETH_META,
      outputMeta: USDC_META,
      inputAmount: 500_000_000_000_000n, // 0.0005 WETH
      expectedOutput: 1_400_000n, // 1.40 USDC
      fee: 14_000n, // 0.014 USDC
      tool: "sushiswap",
      expiresAt: new Date(1_900_000_000_000),
      publicBaseUrl: "https://proxy.suverse.io",
      direction: "reverse",
      approvalTarget: "0x4261701A4dDf4625EBfA80CEefB5B3B2b5453B2E",
    });
    expect(r.direction).toBe("reverse");
    expect(r.requires_approval).toBe(true);
    expect(r.approval_target).toBe(
      "0x4261701A4dDf4625EBfA80CEefB5B3B2b5453B2E",
    );
    expect(r.total_cost).toBe("14000");
    expect(r.total_cost_human).toBe("0.014 USDC");
    expect(r.fee_human).toBe("0.014 USDC");
    expect(r.expected_output_human).toBe("1.4 USDC");
  });

  it("forward direction: requires_approval=false, approval_target absent", () => {
    const r = buildBaseQuoteResponse({
      quoteId: "qb_fwd",
      inputMeta: USDC_META,
      outputMeta: WETH_META,
      inputAmount: 10_000_000n,
      expectedOutput: 2_500_000_000_000_000n,
      fee: 100_000n,
      tool: "uniswap-v3",
      expiresAt: new Date(1_900_000_000_000),
      publicBaseUrl: "https://proxy.suverse.io",
      direction: "forward",
    });
    expect(r.direction).toBe("forward");
    expect(r.requires_approval).toBe(false);
    expect(r.approval_target).toBeUndefined();
  });

  it("omits gas-guard fields when no guard is supplied", () => {
    const r = buildBaseQuoteResponse({
      quoteId: "qb_no_guard",
      inputMeta: USDC_META,
      outputMeta: WETH_META,
      inputAmount: 1_000_000n,
      expectedOutput: 250_000_000_000_000n,
      fee: 10_000n,
      tool: "uniswap-v3",
      expiresAt: new Date(1_900_000_000_000),
      publicBaseUrl: "https://proxy.suverse.io",
      direction: "forward",
    });
    expect(r.minimum_input_atomic).toBeUndefined();
    expect(r.estimated_gas_cost_usd).toBeUndefined();
    expect(r.gas_warning).toBeUndefined();
  });
});
