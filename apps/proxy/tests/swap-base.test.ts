/**
 * Focused unit tests for the pure helpers in swap-base.ts —
 * buildBaseQuoteResponse formatting + gas-guard field threading +
 * reverse-direction execute orchestration. The forward execute path
 * is exercised end-to-end by the swap-base-smoke script and the
 * integration suite; we don't double-cover it here.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newDb } from "pg-mem";
import type { Address, Hex } from "viem";
import Fastify, { type FastifyInstance } from "fastify";
import {
  BASE_CAIP2,
  buildBaseQuoteResponse,
  computeFee,
  MAX_INPUT_USDC_ATOMIC,
  registerBaseSwapRoutes,
  USDC_BASE,
  validateBaseQuoteInput,
  executeBaseSwap,
  type BaseSwapChain,
  type BaseSwapSignerConfig,
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

// --------------------------------------------- executeBaseSwap reverse ----

const HERE_BASE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR_BASE = join(HERE_BASE, "..", "..", "..", "db", "migrations");

async function freshDb() {
  const { runMigrations } = await import("../../../db/dist/migrate.js");
  const db = newDb({ noAstCoverageCheck: true });
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await runMigrations({
    client: pool as never,
    migrationsDir: MIGRATIONS_DIR_BASE,
    log: () => {},
  });
  return pool as unknown as import("pg").Pool;
}

const SWAP_WALLET = "0x4261701A4dDf4625EBfA80CEefB5B3B2b5453B2E" as Address;
const FAKE_BUYER = "0x3869dE7597bDEa0172B97143f3eed806D8b84bf3" as Address;

interface FakeBaseChain extends BaseSwapChain {
  readSwapWalletBalance: ReturnType<typeof vi.fn>;
  readAllowance: ReturnType<typeof vi.fn>;
  readAllowanceOf: ReturnType<typeof vi.fn>;
  approveERC20: ReturnType<typeof vi.fn>;
  sendSwapTx: ReturnType<typeof vi.fn>;
  transferERC20: ReturnType<typeof vi.fn>;
  transferFromBuyer: ReturnType<typeof vi.fn>;
}

function fakeBaseChain(opts?: {
  buyerAllowance?: bigint;
  swapAllowance?: bigint;
  preUsdc?: bigint;
  postUsdc?: bigint;
  pullTx?: Hex;
  swapTx?: Hex;
  transferTx?: Hex;
}): FakeBaseChain {
  let balCalls = 0;
  return {
    readSwapWalletBalance: vi.fn().mockImplementation(async () => {
      balCalls += 1;
      return balCalls === 1 ? (opts?.preUsdc ?? 0n) : (opts?.postUsdc ?? 1_400_000n);
    }),
    readAllowance: vi
      .fn()
      .mockResolvedValue(opts?.swapAllowance ?? 0n),
    readAllowanceOf: vi
      .fn()
      .mockResolvedValue(opts?.buyerAllowance ?? 0n),
    approveERC20: vi
      .fn()
      .mockResolvedValue({ txHash: "0xapprove" as Hex }),
    sendSwapTx: vi
      .fn()
      .mockResolvedValue({ txHash: (opts?.swapTx ?? "0xswap") as Hex, blockNumber: 123n }),
    transferERC20: vi
      .fn()
      .mockResolvedValue({ txHash: (opts?.transferTx ?? "0xxfer") as Hex }),
    transferFromBuyer: vi
      .fn()
      .mockResolvedValue({ txHash: (opts?.pullTx ?? "0xpull") as Hex, blockNumber: 122n }),
  };
}

async function insertReverseQuote(
  pool: import("pg").Pool,
  overrides: Partial<{ quoteId: string; inputAmount: string; expectedOutput: string; expiresAt: Date }> = {},
) {
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID();
  const quoteId = overrides.quoteId ?? "qb_rev_test";
  const inputAmount = overrides.inputAmount ?? "500000000000000"; // 0.0005 WETH
  const expectedOutput = overrides.expectedOutput ?? "1400000"; // 1.40 USDC
  const expiresAt = overrides.expiresAt ?? new Date(Date.now() + 60_000);
  await pool.query(
    `INSERT INTO swap_transactions (
       id, quote_id, network, input_token, output_token,
       input_amount, expected_output, slippage_bps, fee_amount,
       expires_at, status, jupiter_quote
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      quoteId,
      "eip155:8453",
      WETH_META.mint,
      USDC_BASE,
      inputAmount,
      expectedOutput,
      100,
      "14000",
      expiresAt.toISOString(),
      "quoted",
      JSON.stringify({ direction: "reverse" }),
    ],
  );
  return { id, quoteId };
}

function makeLifiReverseResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "lifi_q_rev",
      tool: "sushiswap",
      estimate: {
        approvalAddress: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
        toAmount: "1400000",
        toAmountMin: "1386000",
        fromAmount: "500000000000000",
      },
      transactionRequest: {
        to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
        data: "0xdeadbeef",
        value: "0x0",
        gasLimit: "200000",
        gasPrice: "5000000",
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("executeBaseSwap (reverse direction)", () => {
  let pool: import("pg").Pool;
  beforeEach(async () => {
    pool = await freshDb();
  });
  afterEach(async () => {
    await pool.end();
    vi.restoreAllMocks();
  });

  it("returns needs_approval when buyer allowance < input_amount", async () => {
    const { quoteId } = await insertReverseQuote(pool);
    const chain = fakeBaseChain({ buyerAllowance: 0n });
    const fetchImpl = vi.fn().mockResolvedValueOnce(makeLifiReverseResponse());
    const r = await executeBaseSwap({
      quoteId,
      recipient: FAKE_BUYER,
      inboundPaymentId: null,
      pool,
      chain,
      swapWalletAddress: SWAP_WALLET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.kind).toBe("needs_approval");
    if (r.kind === "needs_approval") {
      expect(r.token.toLowerCase()).toBe(WETH_META.mint.toLowerCase());
      expect(r.owner).toBe(FAKE_BUYER);
      expect(r.spender).toBe(SWAP_WALLET);
      expect(r.requiredAllowance).toBe(500_000_000_000_000n);
      expect(r.currentAllowance).toBe(0n);
    }
    // transferFrom must NOT have been called.
    expect(chain.transferFromBuyer).not.toHaveBeenCalled();
  });

  it("happy path: pulls, approves LiFi spender if needed, swaps, transfers USDC", async () => {
    const { quoteId } = await insertReverseQuote(pool);
    const chain = fakeBaseChain({
      buyerAllowance: 1_000_000_000_000_000n, // enough
      swapAllowance: 0n, // LiFi spender needs first-time approval
      preUsdc: 0n,
      postUsdc: 1_400_000n,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(makeLifiReverseResponse())
      .mockResolvedValueOnce(makeLifiReverseResponse());
    const r = await executeBaseSwap({
      quoteId,
      recipient: FAKE_BUYER,
      inboundPaymentId: null,
      pool,
      chain,
      swapWalletAddress: SWAP_WALLET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.pullTxHash).toBe("0xpull");
      expect(r.approveTxHash).toBe("0xapprove");
      expect(r.swapTxHash).toBe("0xswap");
      expect(r.transferTxHash).toBe("0xxfer");
      expect(r.outputAmount).toBe(1_400_000n);
    }
    expect(chain.transferFromBuyer).toHaveBeenCalledTimes(1);
    expect(chain.approveERC20).toHaveBeenCalledTimes(1);
  });

  it("skips LiFi-spender approve when allowance already covers the input", async () => {
    const { quoteId } = await insertReverseQuote(pool);
    const chain = fakeBaseChain({
      buyerAllowance: 1_000_000_000_000_000n,
      swapAllowance: 999_999_999_999_999_999n,
      preUsdc: 0n,
      postUsdc: 1_400_000n,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(makeLifiReverseResponse());
    const r = await executeBaseSwap({
      quoteId,
      recipient: FAKE_BUYER,
      inboundPaymentId: null,
      pool,
      chain,
      swapWalletAddress: SWAP_WALLET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.approveTxHash).toBeNull();
    expect(chain.approveERC20).not.toHaveBeenCalled();
  });

  it("flags slippage when delivered USDC falls below toAmountMin", async () => {
    const { quoteId } = await insertReverseQuote(pool);
    const chain = fakeBaseChain({
      buyerAllowance: 1_000_000_000_000_000n,
      swapAllowance: 999_999_999_999_999_999n,
      preUsdc: 0n,
      postUsdc: 1_000_000n, // way under toAmountMin = 1_386_000
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(makeLifiReverseResponse());
    const r = await executeBaseSwap({
      quoteId,
      recipient: FAKE_BUYER,
      inboundPaymentId: null,
      pool,
      chain,
      swapWalletAddress: SWAP_WALLET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.kind).toBe("slippage");
    if (r.kind === "slippage") {
      expect(r.expectedMin).toBe(1_386_000n);
      expect(r.actual).toBe(1_000_000n);
    }
  });
});

// --------------------------------------------- POST /v1/swap/base/quote ----

describe("POST /v1/swap/base/quote", () => {
  let app: FastifyInstance;
  let pool: import("pg").Pool;

  const baseSigner: BaseSwapSignerConfig = {
    address: SWAP_WALLET,
    privateKey: ("0x" + "ab".repeat(32)) as Hex,
  };

  const baseChain: BaseSwapChain = {
    readSwapWalletBalance: vi.fn().mockResolvedValue(0n),
    readAllowance: vi.fn().mockResolvedValue(0n),
    readAllowanceOf: vi.fn().mockResolvedValue(0n),
    approveERC20: vi.fn(),
    sendSwapTx: vi.fn(),
    transferERC20: vi.fn(),
    transferFromBuyer: vi.fn(),
  };

  beforeEach(async () => {
    pool = await freshDb();
    // Routed fetchImpl: facilitator paths return success stubs; any
    // other URL throws because the 402-challenge test never reaches
    // LiFi.
    const fetchImpl = vi.fn().mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith("/facilitator/supported")) {
        return new Response(JSON.stringify({ kinds: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    app = Fastify({ logger: false });
    app.removeAllContentTypeParsers();
    app.addContentTypeParser(
      "*",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );
    registerBaseSwapRoutes(app, {
      pool,
      facilitatorUrl: "https://facilitator.example",
      facilitatorApiKey: "sup_live_test",
      swapSigner: baseSigner,
      chain: baseChain,
      publicBaseUrl: "https://proxy.suverse.io",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await pool.end();
    vi.restoreAllMocks();
  });

  it("402 when called without X-Payment, with bazaar extension and 1-atomic accept", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/swap/base/quote",
      payload: {
        input_token: USDC_BASE,
        output_token: WETH_META.mint,
        input_amount: "10000000",
        slippage_bps: 100,
      },
    });
    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0].network).toBe(BASE_CAIP2);
    expect(body.accepts[0].asset).toBe(USDC_BASE);
    expect(body.accepts[0].payTo).toBe(SWAP_WALLET);
    expect(body.accepts[0].amount).toBe("1000");
    expect(body.resource?.url).toBe(
      "https://proxy.suverse.io/v1/swap/base/quote",
    );
    expect(body.extensions?.bazaar?.info).toBeTruthy();
    expect(body.extensions?.bazaar?.info?.output?.example).toBeTypeOf("object");
    expect(
      Array.isArray(body.extensions?.bazaar?.info?.output?.example),
    ).toBe(false);
  });
});
