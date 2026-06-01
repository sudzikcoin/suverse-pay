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
    });
    expect(r.minimum_input_atomic).toBeUndefined();
    expect(r.estimated_gas_cost_usd).toBeUndefined();
    expect(r.gas_warning).toBeUndefined();
  });
});
