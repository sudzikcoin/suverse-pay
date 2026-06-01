/**
 * Unit tests for the Jupiter HTTP wrapper helpers — currently the
 * slippage error detector. The fetch implementations are mocked
 * directly so no network access is required.
 */

import { describe, expect, it } from "vitest";
import {
  isJupiterSlippageError,
  JupiterError,
} from "../src/swap-jupiter.js";

describe("isJupiterSlippageError", () => {
  it("matches a SlippageToleranceExceeded body", () => {
    const err = new JupiterError(
      "jupiter_swap_400",
      `{"error":"SlippageToleranceExceeded","logs":["..."]}`,
      400,
    );
    expect(isJupiterSlippageError(err)).toBe(true);
  });

  it("matches a Raydium 0x1771 selector in the excerpt", () => {
    const err = new JupiterError(
      "jupiter_swap_400",
      "Program log: Error: 0x1771",
      400,
    );
    expect(isJupiterSlippageError(err)).toBe(true);
  });

  it("matches a literal lowercase 'slippage' word", () => {
    const err = new JupiterError(
      "jupiter_swap_503",
      "slippage too tight",
      503,
    );
    expect(isJupiterSlippageError(err)).toBe(true);
  });

  it("returns false for non-slippage Jupiter errors", () => {
    const err = new JupiterError(
      "jupiter_swap_503",
      "internal server error",
      503,
    );
    expect(isJupiterSlippageError(err)).toBe(false);
  });

  it("returns false for non-JupiterError throwables", () => {
    expect(isJupiterSlippageError(new Error("slippage"))).toBe(false);
    expect(isJupiterSlippageError("slippage")).toBe(false);
    expect(isJupiterSlippageError(undefined)).toBe(false);
  });
});
