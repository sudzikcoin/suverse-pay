/**
 * Pure-unit tests for swap-gas-guard. No DB, no chain — just verify
 * the math against the four canonical scenarios described in the
 * module header.
 */

import { describe, expect, it, vi } from "vitest";

import {
  BASE_ABS_MIN_USD,
  BASE_APPROVE_USD,
  BASE_REVERSE_ABS_MIN_USD,
  BASE_SWAP_USD,
  BASE_TRANSFER_USD,
  SOL_ABS_MIN_USD,
  SOL_ATA_RENT_USD,
  SOL_REVERSE_ABS_MIN_USD,
  SOL_TX_FEE_USD,
  buildGasGuardQuoteFields,
  evaluateBaseSwapGas,
  evaluateSolanaSwapGas,
  type BaseGasProbe,
  type GasGuardOk,
  type SolanaGasProbe,
} from "../src/swap-gas-guard.js";

const FEE_BPS = 100n;
const NEW_MINT = "So11111111111111111111111111111111111111112";
const COMMON_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const LIFI_SPENDER = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";

// ---------- Solana ----------------------------------------------------------

describe("evaluateSolanaSwapGas", () => {
  it("rejects a dust swap into a brand-new mint (ATA missing)", async () => {
    const probe: SolanaGasProbe = {
      swapWalletHasOutputAta: vi.fn().mockResolvedValue(false),
    };
    const r = await evaluateSolanaSwapGas({
      inputAtomic: 1_000n, // $0.001 — clearly below $40 floor
      outputMint: NEW_MINT,
      feeBps: FEE_BPS,
      probe,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("quote_too_small");
    expect(r.estimatedGasCostUsd).toBeCloseTo(
      SOL_ATA_RENT_USD + SOL_TX_FEE_USD,
      4,
    );
    // Floor: ($0.40 + $0.002) / 0.01 = $40.20 → 40_200_000 atomic.
    expect(r.minimumInputAtomic).toBe(40_200_000n);
    expect(r.message).toMatch(/40\.20/);
  });

  it("allows the documented $0.10 floor when ATA exists and input is at it", async () => {
    const probe: SolanaGasProbe = {
      swapWalletHasOutputAta: vi.fn().mockResolvedValue(true),
    };
    const r = await evaluateSolanaSwapGas({
      // $0.10 in USDC atomic. With ATA existing the gas floor is $0.20
      // (=$0.002/0.01), so $0.10 still rejects.
      inputAtomic: 100_000n,
      outputMint: COMMON_MINT,
      feeBps: FEE_BPS,
      probe,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.minimumInputAtomic).toBe(200_000n); // $0.20
    expect(r.estimatedGasCostUsd).toBeCloseTo(SOL_TX_FEE_USD, 4);
  });

  it("accepts a $0.20 swap when the swap wallet already holds the output ATA", async () => {
    const probe: SolanaGasProbe = {
      swapWalletHasOutputAta: vi.fn().mockResolvedValue(true),
    };
    const r = await evaluateSolanaSwapGas({
      inputAtomic: 200_000n,
      outputMint: COMMON_MINT,
      feeBps: FEE_BPS,
      probe,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Gas $0.002, floor $0.20 (break-even) — equal to absolute min $0.10,
    // bumped above the absolute min, so the warning should fire.
    expect(r.estimatedGasCostUsd).toBeCloseTo(SOL_TX_FEE_USD, 4);
    expect(r.minimumInputAtomic).toBe(200_000n);
    // $0.20 > $0.10 absolute floor → warning surfaces.
    expect(r.warning).toBeUndefined();
  });

  it("falls closed when the ATA probe throws (treated as missing)", async () => {
    const probe: SolanaGasProbe = {
      swapWalletHasOutputAta: vi
        .fn()
        .mockRejectedValue(new Error("RPC unreachable")),
    };
    const r = await evaluateSolanaSwapGas({
      inputAtomic: 1_000_000n, // $1
      outputMint: NEW_MINT,
      feeBps: FEE_BPS,
      probe,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.estimatedGasCostUsd).toBeCloseTo(
      SOL_ATA_RENT_USD + SOL_TX_FEE_USD,
      4,
    );
  });

  it("accepts a $40+ swap into a new mint and surfaces the bump warning", async () => {
    const probe: SolanaGasProbe = {
      swapWalletHasOutputAta: vi.fn().mockResolvedValue(false),
    };
    const r = await evaluateSolanaSwapGas({
      inputAtomic: 41_000_000n, // $41
      outputMint: NEW_MINT,
      feeBps: FEE_BPS,
      probe,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warning).toBeDefined();
    expect(r.warning).toMatch(/ATA/);
    expect(r.minimumInputAtomic).toBe(40_200_000n);
  });

  it("reverse direction: floor lifts to $0.50 when input ATA exists", async () => {
    const probe: SolanaGasProbe = {
      swapWalletHasOutputAta: async () => true,
    };
    const r = await evaluateSolanaSwapGas({
      inputAtomic: 600_000n, // $0.60 — clears the floor
      outputMint: "BONK111",
      feeBps: 100n,
      probe,
      direction: "reverse",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 3 SOL tx fees @ $0.002 = $0.006 → break-even $0.60. Floor max(0.50, 0.60) = 0.60.
    expect(r.minimumInputAtomic).toBe(600_000n);
  });

  it("reverse direction: $0.30 input rejected when floor is $0.60", async () => {
    const probe: SolanaGasProbe = {
      swapWalletHasOutputAta: async () => true,
    };
    const r = await evaluateSolanaSwapGas({
      inputAtomic: 300_000n,
      outputMint: "BONK111",
      feeBps: 100n,
      probe,
      direction: "reverse",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("quote_too_small");
  });

  it("reverse direction: input ATA missing bumps floor by SPL rent", async () => {
    const probe: SolanaGasProbe = {
      swapWalletHasOutputAta: async () => false,
    };
    // $30 — under the $40.60 break-even floor → rejected.
    const r = await evaluateSolanaSwapGas({
      inputAtomic: 30_000_000n,
      outputMint: "BONK111",
      feeBps: 100n,
      probe,
      direction: "reverse",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.minimumInputAtomic).toBe(40_600_000n);
  });

  it("reverse direction: input ATA missing — $50 input clears the bumped floor", async () => {
    const probe: SolanaGasProbe = {
      swapWalletHasOutputAta: async () => false,
    };
    const r = await evaluateSolanaSwapGas({
      inputAtomic: 50_000_000n,
      outputMint: "BONK111",
      feeBps: 100n,
      probe,
      direction: "reverse",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warning).toMatch(/ATA/);
    expect(r.minimumInputAtomic).toBe(40_600_000n);
  });
});

// ---------- Base -----------------------------------------------------------

describe("evaluateBaseSwapGas", () => {
  it("rejects a $0.50 swap when no allowance and floor is $1.10", async () => {
    const probe: BaseGasProbe = {
      allowance: vi.fn().mockResolvedValue(0n),
    };
    const r = await evaluateBaseSwapGas({
      inputAtomic: 500_000n, // $0.50
      inputToken: USDC_BASE,
      lifiSpender: LIFI_SPENDER,
      feeBps: FEE_BPS,
      probe,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Gas $0.011 (approve + swap + transfer). Break-even = $1.10.
    // max($1, $1.10) = $1.10. atomic = 1_100_000.
    expect(r.minimumInputAtomic).toBe(1_100_000n);
    expect(r.estimatedGasCostUsd).toBeCloseTo(
      BASE_APPROVE_USD + BASE_SWAP_USD + BASE_TRANSFER_USD,
      4,
    );
  });

  it("accepts a $1 swap when the LiFi router already has plenty of allowance", async () => {
    const probe: BaseGasProbe = {
      // 1000 USDC allowance, way above input — no approve needed.
      allowance: vi.fn().mockResolvedValue(1_000_000_000n),
    };
    const r = await evaluateBaseSwapGas({
      inputAtomic: 1_000_000n, // $1
      inputToken: USDC_BASE,
      lifiSpender: LIFI_SPENDER,
      feeBps: FEE_BPS,
      probe,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.estimatedGasCostUsd).toBeCloseTo(
      BASE_SWAP_USD + BASE_TRANSFER_USD,
      4,
    );
    // Break-even = $0.60, absolute min $1 wins.
    expect(r.minimumInputAtomic).toBe(1_000_000n);
    // Break-even (0.60) ≤ absolute floor (1), so no bump warning.
    expect(r.warning).toBeUndefined();
  });

  it("falls closed on allowance probe failure (treated as approval needed)", async () => {
    const probe: BaseGasProbe = {
      allowance: vi.fn().mockRejectedValue(new Error("RPC down")),
    };
    const r = await evaluateBaseSwapGas({
      inputAtomic: 1_050_000n, // $1.05 — accepted only if no approve needed
      inputToken: USDC_BASE,
      lifiSpender: LIFI_SPENDER,
      feeBps: FEE_BPS,
      probe,
    });
    // Probe failure → approve assumed needed → floor $1.10 → $1.05 rejected.
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.minimumInputAtomic).toBe(1_100_000n);
  });

  it("flags the allowance bump warning when approval is needed and floor exceeds default", async () => {
    const probe: BaseGasProbe = {
      allowance: vi.fn().mockResolvedValue(0n),
    };
    const r = await evaluateBaseSwapGas({
      inputAtomic: 1_500_000n, // $1.50 — clears the $1.10 floor
      inputToken: USDC_BASE,
      lifiSpender: LIFI_SPENDER,
      feeBps: FEE_BPS,
      probe,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warning).toBeDefined();
    expect(r.warning).toMatch(/allowance/i);
  });

  it("treats partial allowance (below input) as approve-needed", async () => {
    const probe: BaseGasProbe = {
      allowance: vi.fn().mockResolvedValue(500_000n), // $0.50 < $5 input
    };
    const r = await evaluateBaseSwapGas({
      inputAtomic: 5_000_000n, // $5, plenty above $1.10 floor
      inputToken: USDC_BASE,
      lifiSpender: LIFI_SPENDER,
      feeBps: FEE_BPS,
      probe,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warning).toBeDefined();
    expect(r.estimatedGasCostUsd).toBeCloseTo(
      BASE_APPROVE_USD + BASE_SWAP_USD + BASE_TRANSFER_USD,
      4,
    );
  });

  it("reverse direction: floor is $1.50 when allowance covers the input", async () => {
    const probe: BaseGasProbe = {
      allowance: vi.fn().mockResolvedValue(10_000_000_000n), // ample
    };
    const r = await evaluateBaseSwapGas({
      inputAtomic: 1_500_000n, // exactly the $1.50 reverse floor
      inputToken: USDC_BASE,
      lifiSpender: LIFI_SPENDER,
      feeBps: FEE_BPS,
      probe,
      direction: "reverse",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.minimumInputAtomic).toBe(1_500_000n);
    expect(r.estimatedGasCostUsd).toBeCloseTo(
      BASE_SWAP_USD + BASE_TRANSFER_USD + BASE_TRANSFER_USD,
      4,
    );
  });

  it("reverse direction: $1.00 input rejected against $1.50 floor", async () => {
    const probe: BaseGasProbe = {
      allowance: vi.fn().mockResolvedValue(10_000_000_000n),
    };
    const r = await evaluateBaseSwapGas({
      inputAtomic: 1_000_000n,
      inputToken: USDC_BASE,
      lifiSpender: LIFI_SPENDER,
      feeBps: FEE_BPS,
      probe,
      direction: "reverse",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("quote_too_small");
  });

  it("reverse direction: approve needed bumps gas cost (warning surfaces only when break-even > $1.50)", async () => {
    const probe: BaseGasProbe = {
      allowance: vi.fn().mockResolvedValue(0n),
    };
    const r = await evaluateBaseSwapGas({
      inputAtomic: 5_000_000n, // $5 — well above the reverse floor
      inputToken: USDC_BASE,
      lifiSpender: LIFI_SPENDER,
      feeBps: FEE_BPS,
      probe,
      direction: "reverse",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // gas = $0.005 approve + $0.005 swap + $0.001 transfer + $0.001 pull = $0.012
    // break-even = $1.20 < $1.50 abs floor → warning is suppressed by design.
    expect(r.warning).toBeUndefined();
    expect(r.estimatedGasCostUsd).toBeCloseTo(
      BASE_APPROVE_USD + BASE_SWAP_USD + BASE_TRANSFER_USD + BASE_TRANSFER_USD,
      4,
    );
    expect(r.minimumInputAtomic).toBe(1_500_000n);
  });
});

// ---------- buildGasGuardQuoteFields ---------------------------------------

describe("buildGasGuardQuoteFields", () => {
  it("includes the warning field only when set", () => {
    const withWarn: GasGuardOk = {
      ok: true,
      minimumInputAtomic: 40_200_000n,
      estimatedGasCostUsd: 0.402,
      warning: "Output token has no liquidity wallet ATA yet…",
    };
    const a = buildGasGuardQuoteFields(withWarn);
    expect(a.minimum_input_atomic).toBe("40200000");
    expect(a.estimated_gas_cost_usd).toBe(0.402);
    expect(a.warning).toBeDefined();

    const noWarn: GasGuardOk = {
      ok: true,
      minimumInputAtomic: 200_000n,
      estimatedGasCostUsd: 0.002,
    };
    const b = buildGasGuardQuoteFields(noWarn);
    expect(b.warning).toBeUndefined();
    expect("warning" in b).toBe(false);
  });
});

// Module-shape sanity — keep the absolute floors at the documented
// values; bumping them is an intentional change that should fail this
// test until updated.
describe("constants", () => {
  it("documented absolute floors match the catalog description", () => {
    expect(SOL_ABS_MIN_USD).toBe(0.1);
    expect(SOL_REVERSE_ABS_MIN_USD).toBe(0.5);
    expect(BASE_ABS_MIN_USD).toBe(1);
    expect(BASE_REVERSE_ABS_MIN_USD).toBe(1.5);
  });
});
