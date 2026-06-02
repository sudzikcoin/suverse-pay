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

  it("accepts non-USDC input as reverse direction", () => {
    const r = validateQuoteInput({
      input_mint: REAL_WSOL,
      output_mint: REAL_USDC,
      input_amount: "1000000",
      slippage_bps: 100,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.req.direction).toBe("reverse");
  });

  it("rejects when neither side is USDC", () => {
    const r = validateQuoteInput({
      input_mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      output_mint: REAL_WSOL,
      input_amount: "1000000",
      slippage_bps: 100,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("one_side_must_be_usdc");
  });

  it("forward direction enforces MAX cap pre-quote", () => {
    const r = validateQuoteInput({
      input_mint: REAL_USDC,
      output_mint: REAL_WSOL,
      input_amount: (MAX_INPUT_USDC_ATOMIC + 1n).toString(),
      slippage_bps: 100,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("input_amount_exceeds_max");
  });

  it("reverse direction does NOT cap input pre-quote (caller checks expected_output)", () => {
    // 10000 WSOL atomic is fine for reverse — input is in SPL atomic
    // units, not USDC. The route handler caps on expected_output.
    const r = validateQuoteInput({
      input_mint: REAL_WSOL,
      output_mint: REAL_USDC,
      input_amount: "999999999999999999",
      slippage_bps: 100,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.req.direction).toBe("reverse");
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
      direction: "forward",
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
      direction: "forward",
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

  it("reverse direction: total_cost is fee-only, denominated in USDC", () => {
    // Reverse: input is WSOL, output is USDC. expected_output = 10 USDC.
    // Fee on the USDC side = 100_000 (0.10 USDC). total_cost should be
    // ONLY the fee — buyer's WSOL is pulled via delegate, not paid via
    // x402.
    const r = buildQuoteResponse({
      quoteId: "q_rev",
      inputMeta: TEST_WSOL_META,
      outputMeta: TEST_USDC_META,
      inputAmount: 50_000_000n, // 0.05 SOL
      expectedOutput: 10_000_000n, // 10 USDC
      fee: 100_000n, // 0.10 USDC
      priceImpactPct: 0.01,
      expiresAt: new Date(1_900_000_000_000),
      publicBaseUrl: "https://proxy.suverse.io",
      direction: "reverse",
      approvalTarget: "HFYkH6SUuXLvzGbuB76vJ8u76NG3X25wdd1A7mDM4cSw",
    });
    expect(r.direction).toBe("reverse");
    expect(r.requires_approval).toBe(true);
    expect(r.approval_target).toBe(
      "HFYkH6SUuXLvzGbuB76vJ8u76NG3X25wdd1A7mDM4cSw",
    );
    expect(r.total_cost).toBe("100000");
    expect(r.total_cost_human).toBe("0.1 USDC");
    expect(r.fee_human).toBe("0.1 USDC");
    expect(r.expected_output_human).toBe("10 USDC");
  });

  it("forward direction sets requires_approval=false and omits approval_target", () => {
    const r = buildQuoteResponse({
      quoteId: "q_fwd",
      inputMeta: TEST_USDC_META,
      outputMeta: TEST_WSOL_META,
      inputAmount: 10_000_000n,
      expectedOutput: 47_900_000n,
      fee: 100_000n,
      priceImpactPct: 0,
      expiresAt: new Date(1_900_000_000_000),
      publicBaseUrl: "https://proxy.suverse.io",
      direction: "forward",
    });
    expect(r.direction).toBe("forward");
    expect(r.requires_approval).toBe(false);
    expect(r.approval_target).toBeUndefined();
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
      direction: "forward",
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
  /**
   * Quote is x402-paid (1 atomic USDC). Tests queue the Jupiter
   * response with `queueJupiter`; the routed fetchImpl drains this
   * queue after auto-stubbing the facilitator's /supported, /verify,
   * /settle calls.
   */
  let jupiterQueue: Response[];
  const queueJupiter = (r: Response) => jupiterQueue.push(r);

  /**
   * Stub X-Payment header. runProtocol only checks (scheme, network)
   * against the seller's acceptedPayments — payload is forwarded
   * verbatim to /verify, which our mock accepts unconditionally.
   */
  const STUB_PAYMENT_HEADER = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      scheme: "exact",
      network: SOLANA_CAIP2,
      payload: { signature: "stub", authorization: {} },
    }),
  ).toString("base64");

  const signer: SwapSignerConfig = {
    address: SWAP_WALLET_ADDR,
    secretKey: new Uint8Array(64), // unused by routes that don't sign
  };

  const chain: SolanaSwapChain = {
    signAndSendVersionedSwap: vi.fn(),
    transferOutput: vi.fn(),
    readSwapWalletBalance: vi.fn().mockResolvedValue(0n),
    // Default to "ATA exists" so existing happy-path tests with $1/$10
    // input clear the gas-cost guard floor. quote_too_small scenarios
    // override this with mockResolvedValueOnce(false).
    hasSwapWalletAta: vi.fn().mockResolvedValue(true),
  };

  beforeEach(async () => {
    pool = await freshDb();
    jupiterQueue = [];
    fetchImpl = vi.fn().mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith("/facilitator/supported")) {
        return new Response(JSON.stringify({ kinds: [] }), { status: 200 });
      }
      if (u.endsWith("/facilitator/verify")) {
        return new Response(
          JSON.stringify({ isValid: true, payer: FAKE_PAYER }),
          { status: 200 },
        );
      }
      if (u.endsWith("/facilitator/settle")) {
        return new Response(
          JSON.stringify({
            success: true,
            transaction: "stub-settle-tx",
            network: SOLANA_CAIP2,
            payer: FAKE_PAYER,
          }),
          { status: 200 },
        );
      }
      const r = jupiterQueue.shift();
      if (r) return r;
      throw new Error(`unexpected fetch: ${u}`);
    });
    // restoreAllMocks() in afterEach wipes the describe-scope
    // mockResolvedValue, so re-apply the gas-guard default here. Any
    // test that wants the "ATA missing" path overrides via
    // mockResolvedValueOnce(false).
    (chain.hasSwapWalletAta as ReturnType<typeof vi.fn>).mockResolvedValue(true);
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

  it("402 when called without X-Payment, with bazaar extension", async () => {
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
    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0].network).toBe(SOLANA_CAIP2);
    expect(body.accepts[0].asset).toBe(USDC_MINT);
    expect(body.accepts[0].payTo).toBe(SWAP_WALLET_ADDR);
    expect(body.accepts[0].amount).toBe("1");
    expect(body.resource?.url).toBe(
      "https://proxy.suverse.io/v1/swap/solana/quote",
    );
    expect(body.extensions?.bazaar?.info).toBeTruthy();
    expect(body.extensions?.bazaar?.info?.input).toBeTruthy();
    expect(body.extensions?.bazaar?.info?.output?.example).toBeTypeOf("object");
    expect(
      Array.isArray(body.extensions?.bazaar?.info?.output?.example),
    ).toBe(false);
  });

  it("400 on missing input_mint", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/swap/solana/quote",
      headers: { "x-payment": STUB_PAYMENT_HEADER },
      payload: { output_mint: REAL_WSOL, input_amount: "10000000", slippage_bps: 100 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("missing_input_mint");
  });

  it("400 on slippage out of range", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/swap/solana/quote",
      headers: { "x-payment": STUB_PAYMENT_HEADER },
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
      headers: { "x-payment": STUB_PAYMENT_HEADER },
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
    queueJupiter(
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
      headers: { "x-payment": STUB_PAYMENT_HEADER },
      payload: {
        input_mint: REAL_USDC,
        output_mint: REAL_WSOL,
        input_amount: "10000000",
        slippage_bps: 100,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["payment-response"]).toBeDefined();
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
    queueJupiter(new Response("upstream go boom", { status: 503 }));
    const res = await app.inject({
      method: "POST",
      url: "/v1/swap/solana/quote",
      headers: { "x-payment": STUB_PAYMENT_HEADER },
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

  it("400 quote_too_small when output ATA is missing and input is below the bumped floor", async () => {
    // Override the chain probe ONCE: swap wallet has no ATA for the
    // output mint → floor jumps to $40.20 (40_200_000 atomic).
    (chain.hasSwapWalletAta as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      false,
    );
    queueJupiter(
      new Response(
        JSON.stringify({
          inputMint: REAL_USDC,
          outputMint: REAL_WSOL,
          inAmount: "1000000",
          outAmount: "4790000",
          otherAmountThreshold: "4742000",
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
      headers: { "x-payment": STUB_PAYMENT_HEADER },
      payload: {
        input_mint: REAL_USDC,
        output_mint: REAL_WSOL,
        input_amount: "1000000", // $1 — well under $40.20
        slippage_bps: 100,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("quote_too_small");
    expect(body.minimum_input_atomic).toBe("40200000");
    expect(typeof body.estimated_gas_cost_usd).toBe("number");
    expect(body.estimated_gas_cost_usd).toBeGreaterThan(0.4);
    expect(body.detail).toMatch(/40\.20/);
    // No DB row should have been written for a rejected quote.
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM swap_transactions");
    expect(rows[0].n).toBe(0);
  });

  it("200 + gas_warning when ATA missing but input clears the bumped floor", async () => {
    (chain.hasSwapWalletAta as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      false,
    );
    queueJupiter(
      new Response(
        JSON.stringify({
          inputMint: REAL_USDC,
          outputMint: REAL_WSOL,
          inAmount: "41000000",
          outAmount: "196500000",
          otherAmountThreshold: "194535000",
          swapMode: "ExactIn",
          slippageBps: 100,
          priceImpactPct: "0.02",
          routePlan: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const res = await app.inject({
      method: "POST",
      url: "/v1/swap/solana/quote",
      headers: { "x-payment": STUB_PAYMENT_HEADER },
      payload: {
        input_mint: REAL_USDC,
        output_mint: REAL_WSOL,
        input_amount: "41000000", // $41 — clears the $40.20 floor
        slippage_bps: 100,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.quote_id).toMatch(/^q_[a-f0-9]+$/);
    expect(body.minimum_input_atomic).toBe("40200000");
    expect(typeof body.estimated_gas_cost_usd).toBe("number");
    expect(body.gas_warning).toBeDefined();
    expect(body.gas_warning).toMatch(/ATA/);
  });

  it("200 happy path on common token does NOT surface gas_warning (floor at absolute default)", async () => {
    queueJupiter(
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
      headers: { "x-payment": STUB_PAYMENT_HEADER },
      payload: {
        input_mint: REAL_USDC,
        output_mint: REAL_WSOL,
        input_amount: "10000000",
        slippage_bps: 100,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // ATA exists → no bumpReason → no gas_warning even though the
    // break-even floor ($0.20) does exceed the absolute floor ($0.10).
    expect(body.minimum_input_atomic).toBe("200000");
    expect(typeof body.estimated_gas_cost_usd).toBe("number");
    expect(body.gas_warning).toBeUndefined();
  });
});

// ----------------------------------------------------- executeSolanaSwap ----

interface FakeChain extends SolanaSwapChain {
  signAndSendVersionedSwap: ReturnType<typeof vi.fn>;
  transferOutput: ReturnType<typeof vi.fn>;
  readSwapWalletBalance: ReturnType<typeof vi.fn>;
  hasSwapWalletAta: ReturnType<typeof vi.fn>;
  readSplDelegate: ReturnType<typeof vi.fn>;
  pullFromBuyer: ReturnType<typeof vi.fn>;
}

function fakeChain(opts?: {
  preBal?: bigint;
  postBal?: bigint;
  signature?: string;
  transferSig?: string;
  /** For reverse tests: buyer's SPL delegate state. Defaults to "no delegate". */
  buyerDelegate?: { delegate: string | null; delegatedAmount: bigint };
  /** For reverse tests: signature returned by transferChecked pull. */
  pullSig?: string;
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
    // executeSolanaSwap doesn't call this — the guard runs at /quote.
    // Default true so any test that ends up using this chain through
    // a future /quote-coupled path still passes.
    hasSwapWalletAta: vi.fn().mockResolvedValue(true),
    readSplDelegate: vi
      .fn()
      .mockResolvedValue(
        opts?.buyerDelegate ?? { delegate: null, delegatedAmount: 0n },
      ),
    pullFromBuyer: vi
      .fn()
      .mockResolvedValue({ signature: opts?.pullSig ?? "pull_sig_123" }),
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

// --------------------------------------------- executeSolanaSwap reverse ----

const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

async function insertReverseQuote(
  pool: import("pg").Pool,
  overrides: Partial<{
    quoteId: string;
    inputAmount: string;
    expectedOutput: string;
    expiresAt: Date;
  }> = {},
) {
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID();
  const quoteId = overrides.quoteId ?? "q_rev_test1";
  const inputAmount = overrides.inputAmount ?? "5000000000"; // 50K BONK
  const expectedOutput = overrides.expectedOutput ?? "330000"; // 0.33 USDC
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
      SOLANA_CAIP2,
      BONK_MINT,
      REAL_USDC,
      inputAmount,
      expectedOutput,
      100,
      "3300",
      expiresAt.toISOString(),
      "quoted",
      JSON.stringify({ direction: "reverse" }),
    ],
  );
  return { id, quoteId };
}

function jupiterReverseResponse(): Response {
  return new Response(
    JSON.stringify({
      inputMint: BONK_MINT,
      outputMint: REAL_USDC,
      inAmount: "5000000000",
      outAmount: "330000",
      otherAmountThreshold: "326700",
      swapMode: "ExactIn",
      slippageBps: 100,
      priceImpactPct: "0.01",
      routePlan: [],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("executeSolanaSwap (reverse direction)", () => {
  let pool: import("pg").Pool;
  beforeEach(async () => {
    pool = await freshDb();
  });
  afterEach(async () => {
    await pool.end();
    vi.restoreAllMocks();
  });

  it("returns needs_approval when buyer has no SPL delegate", async () => {
    const { quoteId } = await insertReverseQuote(pool);
    const chain = fakeChain({
      buyerDelegate: { delegate: null, delegatedAmount: 0n },
    });
    const fetchImpl = vi.fn();
    const r = await executeSolanaSwap({
      quoteId,
      recipient: FAKE_PAYER,
      inboundPaymentId: null,
      pool,
      chain,
      swapWalletAddress: SWAP_WALLET_ADDR,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.kind).toBe("needs_approval");
    if (r.kind === "needs_approval") {
      expect(r.mint).toBe(BONK_MINT);
      expect(r.owner).toBe(FAKE_PAYER);
      expect(r.delegate).toBe(SWAP_WALLET_ADDR);
      expect(r.currentDelegate).toBeNull();
      expect(r.currentDelegatedAmount).toBe(0n);
      expect(r.requiredAmount).toBe(5_000_000_000n);
    }
    expect(chain.pullFromBuyer).not.toHaveBeenCalled();
  });

  it("returns needs_approval when delegate is wrong wallet", async () => {
    const { quoteId } = await insertReverseQuote(pool);
    const chain = fakeChain({
      buyerDelegate: {
        delegate: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", // not us
        delegatedAmount: 10_000_000_000n,
      },
    });
    const fetchImpl = vi.fn();
    const r = await executeSolanaSwap({
      quoteId,
      recipient: FAKE_PAYER,
      inboundPaymentId: null,
      pool,
      chain,
      swapWalletAddress: SWAP_WALLET_ADDR,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.kind).toBe("needs_approval");
    expect(chain.pullFromBuyer).not.toHaveBeenCalled();
  });

  it("happy path: pulls SPL, swaps via Jupiter, transfers USDC to buyer", async () => {
    const { quoteId } = await insertReverseQuote(pool);
    const chain = fakeChain({
      buyerDelegate: {
        delegate: SWAP_WALLET_ADDR,
        delegatedAmount: 10_000_000_000n, // covers 5e9 input
      },
      preBal: 0n,
      postBal: 330_000n,
    });
    const fetchImpl = vi
      .fn()
      // 1st: re-quote
      .mockResolvedValueOnce(jupiterReverseResponse())
      // 2nd: POST /swap (Jupiter build tx)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            swapTransaction: "BASE64_TX",
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
      expect(r.pullSignature).toBe("pull_sig_123");
      expect(r.swapSignature).toBe("swap_sig_123");
      expect(r.transferSignature).toBe("xfer_sig_123");
      expect(r.outputAmount).toBe(330_000n);
    }
    expect(chain.pullFromBuyer).toHaveBeenCalledTimes(1);
  });
});
