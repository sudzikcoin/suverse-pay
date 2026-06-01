/**
 * Unit tests for the two new Binance handlers added in this
 * batch: open-interest history and multi-symbol funding rates.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { binanceFundingBatch } from "../src/handlers/binance-funding-batch.js";
import { binanceOpenInterest } from "../src/handlers/binance-open-interest.js";

function buf(o: unknown): Buffer {
  return Buffer.from(JSON.stringify(o));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────
// binance_open_interest
// ─────────────────────────────────────────────────────────────────────

describe("binanceOpenInterest", () => {
  it("400 when symbol missing", async () => {
    const res = await binanceOpenInterest({ body: buf({}), method: "POST" });
    expect(res.status).toBe(400);
  });

  it("400 when symbol has invalid format", async () => {
    const res = await binanceOpenInterest({
      body: buf({ symbol: "btc-usdt" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("404 on upstream 400 (unknown symbol)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 400 }));
    const res = await binanceOpenInterest({
      body: buf({ symbol: "NOPENOPE" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(404);
  });

  it("503 on upstream 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const res = await binanceOpenInterest({
      body: buf({ symbol: "BTCUSDT" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });

  it("200 computes 24h change % from first vs last", async () => {
    const upstream = [
      { symbol: "BTCUSDT", sumOpenInterest: "10000", sumOpenInterestValue: "650000000", timestamp: 1 },
      { symbol: "BTCUSDT", sumOpenInterest: "10500", sumOpenInterestValue: "680000000", timestamp: 2 },
      { symbol: "BTCUSDT", sumOpenInterest: "11000", sumOpenInterestValue: "710000000", timestamp: 3 },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await binanceOpenInterest({
      body: buf({ symbol: "BTCUSDT" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      current_open_interest: number;
      change_24h_pct: number;
      points: number;
      history: Array<{ open_interest: number }>;
    };
    expect(body.current_open_interest).toBe(11000);
    // (11000 - 10000) / 10000 * 100 = 10
    expect(body.change_24h_pct).toBeCloseTo(10, 4);
    expect(body.points).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────
// binance_funding_batch
// ─────────────────────────────────────────────────────────────────────

describe("binanceFundingBatch", () => {
  it("400 when symbols missing", async () => {
    const res = await binanceFundingBatch({ body: buf({}), method: "POST" });
    expect(res.status).toBe(400);
  });

  it("400 when symbols list is empty", async () => {
    const res = await binanceFundingBatch({
      body: buf({ symbols: [] }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("400 when symbols list contains invalid format", async () => {
    const res = await binanceFundingBatch({
      body: buf({ symbols: ["BTCUSDT", "bad-fmt"] }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("400 when symbols list > 50", async () => {
    const symbols = Array.from({ length: 51 }, (_, i) => `SYM${i}USDT`);
    const res = await binanceFundingBatch({
      body: buf({ symbols }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("200 filters upstream universe, tags missing", async () => {
    const universe = [
      { symbol: "BTCUSDT", markPrice: "60000", indexPrice: "59995", lastFundingRate: "0.0001", nextFundingTime: 1, time: 1 },
      { symbol: "ETHUSDT", markPrice: "3000", indexPrice: "2998.5", lastFundingRate: "-0.00005", nextFundingTime: 1, time: 1 },
      { symbol: "SOLUSDT", markPrice: "150", indexPrice: "149.7", lastFundingRate: "0.0002", nextFundingTime: 1, time: 1 },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(universe), { status: 200 }),
    );
    const res = await binanceFundingBatch({
      body: buf({ symbols: ["BTCUSDT", "ETHUSDT", "DOESNOTEXIST"] }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      requested: number;
      returned: number;
      missing: string[];
      rates: Array<{ symbol: string; funding_rate: number; funding_rate_pct: number }>;
    };
    expect(body.requested).toBe(3);
    expect(body.returned).toBe(2);
    expect(body.missing).toEqual(["DOESNOTEXIST"]);
    const btc = body.rates.find((r) => r.symbol === "BTCUSDT");
    expect(btc).toBeDefined();
    expect(btc!.funding_rate).toBeCloseTo(0.0001, 6);
    expect(btc!.funding_rate_pct).toBeCloseTo(0.01, 6);
  });

  it("503 on upstream 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const res = await binanceFundingBatch({
      body: buf({ symbols: ["BTCUSDT"] }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });
});
