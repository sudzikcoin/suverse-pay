/**
 * Unit tests for the SuVerse Swap routes + orchestration.
 *
 * Layers tested:
 *   - validateQuoteInput / computeFee / buildQuoteResponse — pure
 *   - POST /v1/swap/solana/quote — via Fastify .inject(), pg-mem DB,
 *     mocked Jupiter (vi.fn fetch)
 *   - executeSolanaSwap — pg-mem DB, stub SolanaSwapChain, mocked
 *     Jupiter; covers happy path, slippage rejection, already-taken,
 *     expired quote, refund recording on failure
 *
 * Nothing here touches Solana mainnet, Helius, or real Jupiter — the
 * file is safe to run on CI.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { newDb } from "pg-mem";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  buildQuoteResponse,
  computeFee,
  executeSolanaSwap,
  FEE_BPS,
  MAX_INPUT_USDC_ATOMIC,
  registerSwapRoutes,
  SOLANA_CAIP2,
  USDC_MINT,
  parsePriceImpact,
  validateQuoteInput,
  WSOL_MINT,
  type SolanaSwapChain,
  type SwapSignerConfig,
} from "../src/swap.js";
import { findByQuoteId } from "../src/swap-store.js";
import {
  _resetTokenMetadataCache,
  _seedTokenMetadataCache,
  type TokenMetadata,
} from "../src/lib/token-metadata.js";

const TEST_USDC_META: TokenMetadata = {
  mint: USDC_MINT,
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
};
const TEST_WSOL_META: TokenMetadata = {
  mint: WSOL_MINT,
  symbol: "SOL",
  name: "Wrapped SOL",
  decimals: 9,
};

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "..", "..", "db", "migrations");

// Run all the SQL migrations against a fresh pg-mem and hand back the
// resulting pool. Migrations stop short of seeding any swap_transactions
// rows; tests insert what they need directly.
async function freshDb() {
  const { runMigrations } = await import("../../../db/dist/migrate.js");
  const db = newDb({ noAstCoverageCheck: true });
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await runMigrations({
    client: pool as never,
    migrationsDir: MIGRATIONS_DIR,
    log: () => {},
  });
  return pool as unknown as import("pg").Pool;
}

const REAL_USDC = USDC_MINT;
const REAL_WSOL = WSOL_MINT;
const FAKE_PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SWAP_WALLET_ADDR = "HFYkH6SUuXLvzGbuB76vJ8u76NG3X25wdd1A7mDM4cSw";

// ----------------------------------------------------------- pure helpers ----

describe("validateQuoteInput", () => {
  it("rejects non-object body", () => {
    const r = validateQuoteInput(null);
    expect(r.ok).toBe(false);
  });

  it("rejects non-USDC input mint", () => {
    const r = validateQuoteInput({
      input_mint: REAL_WSOL,
      output_mint: REAL_USDC,
      input_amount: "1000000",
      slippage_bps: 100,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("input_must_be_usdc");
  });

  it("rejects amount above max", () => {
    const r = validateQuoteInput({
      input_mint: REAL_USDC,
      output_mint: REAL_WSOL,
      input_amount: (MAX_INPUT_USDC_ATOMIC + 1n).toString(),
      slippage_bps: 100,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("input_amount_exceeds_max");
  });

  it("rejects slippage below minimum", () => {
    const r = validateQuoteInput({
      input_mint: REAL_USDC,
      output_mint: REAL_WSOL,
      input_amount: "1000000",
      slippage_bps: 5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("slippage_out_of_range");
  });

  it("rejects slippage above maximum", () => {
    const r = validateQuoteInput({
      input_mint: REAL_USDC,
      output_mint: REAL_WSOL,
      input_amount: "1000000",
      slippage_bps: 501,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("slippage_out_of_range");
  });

  it("accepts a well-formed body", () => {
    const r = validateQuoteInput({
      input_mint: REAL_USDC,
      output_mint: REAL_WSOL,
      input_amount: "10000000",
      slippage_bps: 100,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.req.inputAmount).toBe(10_000_000n);
      expect(r.req.slippageBps).toBe(100);
    }
  });

  it("rejects output equal to input", () => {
    const r = validateQuoteInput({
      input_mint: REAL_USDC,
      output_mint: REAL_USDC,
      input_amount: "1000000",
      slippage_bps: 100,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("output_equals_input");
  });
});

describe("computeFee", () => {
  it("computes 1% fee", () => {
    expect(computeFee(10_000_000n)).toBe(100_000n); // 0.10 USDC on $10
  });
  it("rounds up", () => {
    // 1 USDC = 1_000_000 atomic. 1% = 10_000. Already exact.
    expect(computeFee(1_000_000n)).toBe(10_000n);
    // 999 atomic — 1% = 9.99 → ceil to 10.
    expect(computeFee(999n)).toBe(10n);
  });
  it("FEE_BPS is 100", () => {
    expect(FEE_BPS).toBe(100n);
  });
});

describe("buildQuoteResponse", () => {
  it("emits x402_pay_url with the quote id and formatted output", () => {
    const r = buildQuoteResponse({
      quoteId: "q_abc",
      inputMeta: TEST_USDC_META,
      outputMeta: TEST_WSOL_META,
      inputAmount: 10_000_000n,
      expectedOutput: 47_900_000n,
      fee: 100_000n,
      priceImpactPct: 0.05,
      expiresAt: new Date(1_900_000_000_000),
      publicBaseUrl: "https://proxy.suverse.io",
    });
    expect(r.quote_id).toBe("q_abc");
    expect(r.x402_pay_url).toBe(
      "https://proxy.suverse.io/v1/swap/solana/execute/q_abc",
    );
    expect(r.total_cost).toBe("10100000"); // 10 + 0.10 USDC
    expect(r.total_cost_human).toBe("10.1 USDC");
    expect(r.expected_output_human).toBe("0.0479 SOL");
  });

  it("returns input_token / output_token as objects with metadata", () => {
    const r = buildQuoteResponse({
      quoteId: "q_xyz",
      inputMeta: TEST_USDC_META,
      outputMeta: TEST_WSOL_META,
      inputAmount: 10_000_000n,
      expectedOutput: 47_900_000n,
      fee: 100_000n,
      priceImpactPct: 0,
      expiresAt: new Date(1_900_000_000_000),
      publicBaseUrl: "https://proxy.suverse.io",
    });
    expect(r.output_token).toEqual({
      mint: WSOL_MINT,
      symbol: "SOL",
      name: "Wrapped SOL",
      decimals: 9,
    });
    expect(r.input_token.symbol).toBe("USDC");
    expect(r.input_token_mint).toBe(USDC_MINT);
    expect(r.output_token_mint).toBe(WSOL_MINT);
  });

  it("renders UNKNOWN tokens without crashing", () => {
    const unknownMeta: TokenMetadata = {
      mint: "Unknown111",
      symbol: "UNKNOWN",
      name: "Unknown111",
      decimals: 0,
    };
    const r = buildQuoteResponse({
      quoteId: "q_unk",
      inputMeta: TEST_USDC_META,
      outputMeta: unknownMeta,
      inputAmount: 1_000_000n,
      expectedOutput: 12_345n,
      fee: 10_000n,
      priceImpactPct: 0,
      expiresAt: new Date(1_900_000_000_000),
      publicBaseUrl: "https://proxy.suverse.io",
    });
    expect(r.expected_output_human).toBe("12345 UNKNOWN");
    expect(r.output_token.decimals).toBe(0);
  });
});

describe("parsePriceImpact", () => {
  it("parses a Jupiter string decimal to a number", () => {
    expect(parsePriceImpact("0.05")).toBeCloseTo(0.05);
  });
  it("accepts a number input", () => {
    expect(parsePriceImpact(0.123)).toBeCloseTo(0.123);
  });
  it("returns 0 for null / undefined / empty / NaN", () => {
    expect(parsePriceImpact(null)).toBe(0);
    expect(parsePriceImpact(undefined)).toBe(0);
    expect(parsePriceImpact("")).toBe(0);
    expect(parsePriceImpact("not-a-number")).toBe(0);
  });
});

// ----------------------------------------------- POST /v1/swap/solana/quote --

describe("POST /v1/swap/solana/quote", () => {
  let pool: import("pg").Pool;
  let app: FastifyInstance;
  let fetchImpl: ReturnType<typeof vi.fn>;

  const signer: SwapSignerConfig = {
    address: SWAP_WALLET_ADDR,
    secretKey: new Uint8Array(64), // unused by routes that don't sign
  };

  const chain: SolanaSwapChain = {
    signAndSendVersionedSwap: vi.fn(),
    transferOutput: vi.fn(),
    readSwapWalletBalance: vi.fn().mockResolvedValue(0n),
  };

  beforeEach(async () => {
    pool = await freshDb();
    fetchImpl = vi.fn();
    // Seed metadata cache so the /quote handler's lookups don't try
    // to hit tokens.jup.ag through the test's mocked fetch.
    _resetTokenMetadataCache();
    _seedTokenMetadataCache([TEST_USDC_META, TEST_WSOL_META]);
    app = Fastify({ logger: false });
    app.removeAllContentTypeParsers();
    app.addContentTypeParser(
      "*",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );
    registerSwapRoutes(app, {
      pool,
      facilitatorUrl: "https://facilitator.example",
      facilitatorApiKey: "sup_live_test",
      swapSigner: signer,
      chain,
      publicBaseUrl: "https://proxy.suverse.io",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await pool.end();
    _resetTokenMetadataCache();
    vi.restoreAllMocks();
  });

  it("400 on missing input_mint", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/swap/solana/quote",
      payload: { output_mint: REAL_WSOL, input_amount: "10000000", slippage_bps: 100 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("missing_input_mint");
  });

  it("400 on slippage out of range", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/swap/solana/quote",
      payload: {
        input_mint: REAL_USDC,
        output_mint: REAL_WSOL,
        input_amount: "10000000",
        slippage_bps: 5,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("slippage_out_of_range");
  });

  it("400 on amount above max", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/swap/solana/quote",
      payload: {
        input_mint: REAL_USDC,
        output_mint: REAL_WSOL,
        input_amount: (MAX_INPUT_USDC_ATOMIC + 1n).toString(),
        slippage_bps: 100,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("input_amount_exceeds_max");
  });

  it("200 happy path persists row and returns quote_id", async () => {
    fetchImpl.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          inputMint: REAL_USDC,
          outputMint: REAL_WSOL,
          inAmount: "10000000",
          outAmount: "47900000",
          otherAmountThreshold: "47421000",
          swapMode: "ExactIn",
          slippageBps: 100,
          priceImpactPct: "0.05",
          routePlan: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/swap/solana/quote",
      payload: {
        input_mint: REAL_USDC,
        output_mint: REAL_WSOL,
        input_amount: "10000000",
        slippage_bps: 100,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.quote_id).toMatch(/^q_[a-f0-9]+$/);
    expect(body.expected_output).toBe("47900000");
    expect(body.fee).toBe("100000");
    expect(body.total_cost).toBe("10100000");
    expect(body.x402_pay_url).toBe(
      `https://proxy.suverse.io/v1/swap/solana/execute/${body.quote_id}`,
    );
    expect(body.input_token).toEqual({
      mint: REAL_USDC,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
    });
    expect(body.output_token).toEqual({
      mint: REAL_WSOL,
      symbol: "SOL",
      name: "Wrapped SOL",
      decimals: 9,
    });
    expect(body.input_token_mint).toBe(REAL_USDC);
    expect(body.output_token_mint).toBe(REAL_WSOL);
    expect(body.expected_output_human).toBe("0.0479 SOL");
    expect(typeof body.price_impact_pct).toBe("number");
    expect(body.price_impact_pct).toBeCloseTo(0.05);

    const row = await findByQuoteId(pool, body.quote_id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe("quoted");
    expect(row?.network).toBe(SOLANA_CAIP2);
    expect(row?.inputAmount).toBe("10000000");
  });

  it("502 when Jupiter returns 5xx", async () => {
    fetchImpl.mockResolvedValueOnce(
      new Response("upstream go boom", { status: 503 }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/v1/swap/solana/quote",
      payload: {
        input_mint: REAL_USDC,
        output_mint: REAL_WSOL,
        input_amount: "10000000",
        slippage_bps: 100,
      },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("jupiter_quote_503");
  });
});

// ----------------------------------------------------- executeSolanaSwap ----

interface FakeChain extends SolanaSwapChain {
  signAndSendVersionedSwap: ReturnType<typeof vi.fn>;
  transferOutput: ReturnType<typeof vi.fn>;
  readSwapWalletBalance: ReturnType<typeof vi.fn>;
}

function fakeChain(opts?: {
  preBal?: bigint;
  postBal?: bigint;
  signature?: string;
  transferSig?: string;
}): FakeChain {
  let calls = 0;
  return {
    signAndSendVersionedSwap: vi
      .fn()
      .mockResolvedValue({ signature: opts?.signature ?? "swap_sig_123" }),
    transferOutput: vi
      .fn()
      .mockResolvedValue({ signature: opts?.transferSig ?? "xfer_sig_123" }),
    readSwapWalletBalance: vi.fn().mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? (opts?.preBal ?? 0n) : (opts?.postBal ?? 47_500_000n);
    }),
  };
}

async function insertTestQuote(
  pool: import("pg").Pool,
  overrides: Partial<{
    quoteId: string;
    expectedOutput: string;
    inputAmount: string;
    expiresAt: Date;
    status: string;
  }> = {},
) {
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID();
  const quoteId = overrides.quoteId ?? "q_test1";
  const inputAmount = overrides.inputAmount ?? "10000000";
  const expectedOutput = overrides.expectedOutput ?? "47900000";
  const expiresAt = overrides.expiresAt ?? new Date(Date.now() + 60_000);
  const status = overrides.status ?? "quoted";
  await pool.query(
    `INSERT INTO swap_transactions (
       id, quote_id, network, input_token, output_token,
       input_amount, expected_output, slippage_bps, fee_amount,
       expires_at, status, jupiter_quote
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      quoteId,
      SOLANA_CAIP2,
      REAL_USDC,
      REAL_WSOL,
      inputAmount,
      expectedOutput,
      100,
      "100000",
      expiresAt.toISOString(),
      status,
      JSON.stringify({ inputMint: REAL_USDC, outputMint: REAL_WSOL }),
    ],
  );
  return { id, quoteId };
}

describe("executeSolanaSwap", () => {
  let pool: import("pg").Pool;

  beforeEach(async () => {
    pool = await freshDb();
  });
  afterEach(async () => {
    await pool.end();
    vi.restoreAllMocks();
  });

  it("returns expired when the quote_id is unknown", async () => {
    const chain = fakeChain();
    const r = await executeSolanaSwap({
      quoteId: "q_unknown",
      recipient: FAKE_PAYER,
      inboundPaymentId: null,
      pool,
      chain,
      swapWalletAddress: SWAP_WALLET_ADDR,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(r.kind).toBe("expired");
    expect(chain.signAndSendVersionedSwap).not.toHaveBeenCalled();
  });

  it("returns expired and marks row when ttl elapsed", async () => {
    const { quoteId } = await insertTestQuote(pool, {
      expiresAt: new Date(Date.now() - 1_000),
    });
    const chain = fakeChain();
    const r = await executeSolanaSwap({
      quoteId,
      recipient: FAKE_PAYER,
      inboundPaymentId: null,
      pool,
      chain,
      swapWalletAddress: SWAP_WALLET_ADDR,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(r.kind).toBe("expired");
    const row = await findByQuoteId(pool, quoteId);
    expect(row?.status).toBe("expired");
  });

  it("rejects swap when re-quote drift exceeds threshold and records refund", async () => {
    const { quoteId } = await insertTestQuote(pool, {
      expectedOutput: "47900000",
    });
    const chain = fakeChain();
    // Drift 50% — well over 2% threshold.
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          inputMint: REAL_USDC,
          outputMint: REAL_WSOL,
          inAmount: "10000000",
          outAmount: "23950000",
          otherAmountThreshold: "23710000",
          swapMode: "ExactIn",
          slippageBps: 100,
          priceImpactPct: "0.05",
          routePlan: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const r = await executeSolanaSwap({
      quoteId,
      recipient: FAKE_PAYER,
      inboundPaymentId: null,
      pool,
      chain,
      swapWalletAddress: SWAP_WALLET_ADDR,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.kind).toBe("slippage");
    if (r.kind === "slippage") {
      expect(r.bpsTolerance).toBe(100);
      expect(r.actual).toBe(23_950_000n);
      // expectedMin = expectedOutput * (10000 - 100) / 10000 = 47900000 * 0.99
      expect(r.expectedMin).toBe(47_421_000n);
    }
    const row = await findByQuoteId(pool, quoteId);
    expect(row?.status).toBe("failed_slippage");

    const { rows } = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM swap_refunds WHERE swap_id = $1`,
      [row?.id],
    );
    expect(Number(rows[0]?.c)).toBe(1);
  });

  it("happy path completes the swap, transfers, and marks row completed", async () => {
    const { quoteId } = await insertTestQuote(pool, {
      expectedOutput: "47900000",
    });
    const chain = fakeChain({ preBal: 0n, postBal: 47_800_000n });
    const fetchImpl = vi
      .fn()
      // 1st call — re-quote (no drift, fresh = stored)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            inputMint: REAL_USDC,
            outputMint: REAL_WSOL,
            inAmount: "10000000",
            outAmount: "47900000",
            otherAmountThreshold: "47421000",
            swapMode: "ExactIn",
            slippageBps: 100,
            priceImpactPct: "0.05",
            routePlan: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      // 2nd call — POST /swap
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            swapTransaction: "BASE64_TX_HERE",
            lastValidBlockHeight: 100,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    const r = await executeSolanaSwap({
      quoteId,
      recipient: FAKE_PAYER,
      inboundPaymentId: null,
      pool,
      chain,
      swapWalletAddress: SWAP_WALLET_ADDR,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.swapSignature).toBe("swap_sig_123");
      expect(r.transferSignature).toBe("xfer_sig_123");
      expect(r.outputAmount).toBe(47_800_000n);
    }
    const row = await findByQuoteId(pool, quoteId);
    expect(row?.status).toBe("completed");
    expect(row?.actualOutput).toBe("47800000");
    expect(chain.transferOutput).toHaveBeenCalledWith({
      mint: REAL_WSOL,
      amount: 47_800_000n,
      recipient: FAKE_PAYER,
    });
  });

  it("records refund + marks failed when on-chain swap throws", async () => {
    const { quoteId } = await insertTestQuote(pool);
    const chain = fakeChain({ preBal: 0n });
    chain.signAndSendVersionedSwap.mockRejectedValueOnce(
      new Error("swap_tx_failed: InsufficientFunds"),
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            inputMint: REAL_USDC,
            outputMint: REAL_WSOL,
            inAmount: "10000000",
            outAmount: "47900000",
            otherAmountThreshold: "47421000",
            swapMode: "ExactIn",
            slippageBps: 100,
            priceImpactPct: "0.05",
            routePlan: [],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            swapTransaction: "BASE64_TX_HERE",
            lastValidBlockHeight: 100,
          }),
          { status: 200 },
        ),
      );

    const r = await executeSolanaSwap({
      quoteId,
      recipient: FAKE_PAYER,
      inboundPaymentId: null,
      pool,
      chain,
      swapWalletAddress: SWAP_WALLET_ADDR,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") {
      expect(r.refundRecorded).toBe(true);
    }
    const row = await findByQuoteId(pool, quoteId);
    expect(row?.status).toBe("failed");

    const { rows } = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM swap_refunds WHERE swap_id = $1`,
      [row?.id],
    );
    expect(Number(rows[0]?.c)).toBe(1);
  });

  it("returns already_taken when a second caller races a completed quote", async () => {
    const { quoteId } = await insertTestQuote(pool, { status: "completed" });
    const chain = fakeChain();
    const r = await executeSolanaSwap({
      quoteId,
      recipient: FAKE_PAYER,
      inboundPaymentId: null,
      pool,
      chain,
      swapWalletAddress: SWAP_WALLET_ADDR,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(r.kind).toBe("already_taken");
    expect(chain.signAndSendVersionedSwap).not.toHaveBeenCalled();
  });

  it("fails with slippage when delivered amount falls below otherAmountThreshold", async () => {
    const { quoteId } = await insertTestQuote(pool);
    // Pre = 0, post = 30M — way under the 47.4M threshold.
    const chain = fakeChain({ preBal: 0n, postBal: 30_000_000n });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            inputMint: REAL_USDC,
            outputMint: REAL_WSOL,
            inAmount: "10000000",
            outAmount: "47900000",
            otherAmountThreshold: "47421000",
            swapMode: "ExactIn",
            slippageBps: 100,
            priceImpactPct: "0.05",
            routePlan: [],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            swapTransaction: "BASE64_TX_HERE",
            lastValidBlockHeight: 100,
          }),
          { status: 200 },
        ),
      );
    const r = await executeSolanaSwap({
      quoteId,
      recipient: FAKE_PAYER,
      inboundPaymentId: null,
      pool,
      chain,
      swapWalletAddress: SWAP_WALLET_ADDR,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.kind).toBe("slippage");
    if (r.kind === "slippage") {
      expect(r.expectedMin).toBe(47_421_000n);
      expect(r.actual).toBe(30_000_000n);
      expect(r.bpsTolerance).toBe(100);
      expect(r.detail).toContain("delivered_");
    }
    const row = await findByQuoteId(pool, quoteId);
    expect(row?.status).toBe("failed_slippage");
  });

  it("flags Jupiter swap-build slippage failure as kind=slippage", async () => {
    const { quoteId } = await insertTestQuote(pool);
    const chain = fakeChain();
    const fetchImpl = vi
      .fn()
      // re-quote OK
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            inputMint: REAL_USDC,
            outputMint: REAL_WSOL,
            inAmount: "10000000",
            outAmount: "47900000",
            otherAmountThreshold: "47421000",
            swapMode: "ExactIn",
            slippageBps: 100,
            priceImpactPct: "0.05",
            routePlan: [],
          }),
          { status: 200 },
        ),
      )
      // POST /swap returns a body containing the "slippage" keyword
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "SlippageToleranceExceeded",
            message: "0x1771 slippage error",
          }),
          { status: 400 },
        ),
      );
    const r = await executeSolanaSwap({
      quoteId,
      recipient: FAKE_PAYER,
      inboundPaymentId: null,
      pool,
      chain,
      swapWalletAddress: SWAP_WALLET_ADDR,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.kind).toBe("slippage");
    if (r.kind === "slippage") {
      expect(r.expectedMin).toBe(47_421_000n);
      expect(r.actual).toBe(0n);
      expect(r.bpsTolerance).toBe(100);
    }
    const row = await findByQuoteId(pool, quoteId);
    expect(row?.status).toBe("failed_slippage");
  });
});
