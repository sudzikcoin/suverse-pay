/**
 * Unit tests for the five DeFiLlama-backed handlers. Each test
 * stubs `fetchImpl` to an in-memory `Response` — no live network.
 *
 * Coverage per handler:
 *   - upstream 429 → 503 rate_limit_upstream
 *   - upstream 5xx → 502 upstream_error
 *   - happy-path → 200 with normalized body
 *   - input validation where the handler takes parameters
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { defillamaBridges } from "../src/handlers/defillama-bridges.js";
import { defillamaFees } from "../src/handlers/defillama-fees.js";
import { defillamaProtocolTvl } from "../src/handlers/defillama-protocol-tvl.js";
import { defillamaTvlChain } from "../src/handlers/defillama-tvl-chain.js";
import { defillamaYieldPools } from "../src/handlers/defillama-yield-pools.js";

function buf(o: unknown): Buffer {
  return Buffer.from(JSON.stringify(o));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────
// defillama_tvl_chain
// ─────────────────────────────────────────────────────────────────────

describe("defillamaTvlChain", () => {
  it("200 with normalized rows", async () => {
    const upstream = [
      {
        name: "Ethereum",
        chainId: 1,
        tokenSymbol: "ETH",
        tvl: 50_000_000_000,
        change_1d: 0.5,
        change_7d: 2.1,
      },
      {
        name: "Base",
        chainId: 8453,
        tokenSymbol: "ETH",
        tvl: 3_000_000_000,
        change_1d: 1.2,
        change_7d: 4.0,
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await defillamaTvlChain({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as { count: number; chains: Array<Record<string, unknown>> };
    expect(body.count).toBe(2);
    expect(body.chains[0]).toEqual({
      name: "Ethereum",
      chain_id: 1,
      token_symbol: "ETH",
      tvl_usd: 50_000_000_000,
      change_1d: 0.5,
      change_7d: 2.1,
    });
  });

  it("503 on upstream 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const res = await defillamaTvlChain({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });

  it("502 on upstream 5xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    const res = await defillamaTvlChain({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(502);
  });
});

// ─────────────────────────────────────────────────────────────────────
// defillama_protocol_tvl
// ─────────────────────────────────────────────────────────────────────

describe("defillamaProtocolTvl", () => {
  it("400 when protocol missing", async () => {
    const res = await defillamaProtocolTvl({ body: buf({}), method: "POST" });
    expect(res.status).toBe(400);
  });

  it("400 on invalid protocol slug (uppercase / dot)", async () => {
    const res = await defillamaProtocolTvl({
      body: buf({ protocol: "Aave.v3" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe(
      "invalid_protocol_format",
    );
  });

  it("404 when upstream 404", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    const res = await defillamaProtocolTvl({
      body: buf({ protocol: "does-not-exist" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(404);
  });

  it("slices history to last 90 days", async () => {
    const tvl = Array.from({ length: 200 }, (_, i) => ({
      date: 1_780_000_000 + i,
      totalLiquidityUSD: 1000 + i,
    }));
    const upstream = {
      name: "Aave V3",
      symbol: "AAVE",
      chain: "Ethereum",
      category: "Lending",
      tvl,
      currentChainTvls: { Ethereum: 1199 },
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await defillamaProtocolTvl({
      body: buf({ protocol: "aave-v3" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const body = res.body as {
      protocol: string;
      name: string;
      tvl_series_days: number;
      tvl_series: Array<{ date: number; tvl_usd: number }>;
    };
    expect(body.tvl_series_days).toBe(90);
    expect(body.tvl_series[0].tvl_usd).toBe(1110); // index 110
    expect(body.tvl_series[89].tvl_usd).toBe(1199);
  });
});

// ─────────────────────────────────────────────────────────────────────
// defillama_yield_pools
// ─────────────────────────────────────────────────────────────────────

describe("defillamaYieldPools", () => {
  it("filters by min_tvl, sorts by apy desc, caps at limit", async () => {
    const pools = Array.from({ length: 100 }, (_, i) => ({
      pool: `p-${i}`,
      chain: "Ethereum",
      project: "aave-v3",
      symbol: `T${i}`,
      tvlUsd: i < 50 ? 500_000 : 50_000_000, // first 50 BELOW default $1M floor
      apy: i,
      ilRisk: "no",
      stablecoin: i % 2 === 0,
    }));
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: pools }), { status: 200 }),
    );
    const res = await defillamaYieldPools({
      body: buf({ limit: 5 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      universe_size: number;
      count: number;
      pools: Array<{ apy: number; tvl_usd: number }>;
    };
    expect(body.universe_size).toBe(100);
    expect(body.count).toBe(5);
    // Highest APY in the kept (≥$1M) bucket is index 99.
    expect(body.pools[0].apy).toBe(99);
    expect(body.pools[4].apy).toBe(95);
    // Floor enforced.
    expect(body.pools.every((p) => p.tvl_usd >= 1_000_000)).toBe(true);
  });

  it("respects custom min_tvl", async () => {
    const pools = [
      { pool: "a", chain: "X", project: "x", symbol: "A", tvlUsd: 5_000_000, apy: 10 },
      { pool: "b", chain: "X", project: "x", symbol: "B", tvlUsd: 200_000_000, apy: 5 },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: pools }), { status: 200 }),
    );
    const res = await defillamaYieldPools({
      body: buf({ min_tvl: 100_000_000 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const body = res.body as { count: number; pools: Array<{ pool_id: string }> };
    expect(body.count).toBe(1);
    expect(body.pools[0].pool_id).toBe("b");
  });

  it("400 on negative min_tvl", async () => {
    const res = await defillamaYieldPools({
      body: buf({ min_tvl: -1 }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────
// defillama_bridges
// ─────────────────────────────────────────────────────────────────────

describe("defillamaBridges", () => {
  it("accepts bare-array shape", async () => {
    const upstream = [
      { name: "stargate", displayName: "Stargate", volumePrevDay: 100, txsPrevDay: 50, chains: ["Ethereum", "Base"] },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await defillamaBridges({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as { count: number; bridges: Array<{ name: string }> };
    expect(body.count).toBe(1);
    expect(body.bridges[0].name).toBe("stargate");
  });

  it("accepts {bridges:[...]} envelope shape", async () => {
    const upstream = {
      bridges: [
        { name: "across", displayName: "Across", volumePrevDay: 200, txsPrevDay: 30, chains: ["Optimism"] },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await defillamaBridges({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const body = res.body as { count: number };
    expect(body.count).toBe(1);
  });

  it("503 on 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const res = await defillamaBridges({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });
});

// ─────────────────────────────────────────────────────────────────────
// defillama_fees
// ─────────────────────────────────────────────────────────────────────

describe("defillamaFees", () => {
  it("200 normalizes protocols + market_totals", async () => {
    const upstream = {
      total24h: 12_000_000,
      total7d: 90_000_000,
      total30d: 380_000_000,
      protocols: [
        {
          name: "Uniswap",
          category: "Dexes",
          total24h: 2_000_000,
          total7d: 14_000_000,
          total30d: 60_000_000,
          chains: ["Ethereum", "Polygon"],
          change_1d: 1.2,
        },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await defillamaFees({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const body = res.body as {
      market_totals: { total_24h: number };
      protocols: Array<{ name: string; fees_24h: number }>;
    };
    expect(body.market_totals.total_24h).toBe(12_000_000);
    expect(body.protocols[0].name).toBe("Uniswap");
    expect(body.protocols[0].fees_24h).toBe(2_000_000);
  });

  it("503 on 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const res = await defillamaFees({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });
});
