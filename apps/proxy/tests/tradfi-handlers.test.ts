/**
 * Unit tests for the four "tradfi" handlers added in this batch:
 *   - DeFiLlama stablecoins (the one DeFiLlama path still on free)
 *   - Yahoo single + batch stock quotes
 *   - Frankfurter latest + historical FX rates
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { defillamaStablecoins } from "../src/handlers/defillama-stablecoins.js";
import { frankfurterHistorical } from "../src/handlers/frankfurter-historical.js";
import { frankfurterRatesBatch } from "../src/handlers/frankfurter-rates-batch.js";
import { yahooStockBatch } from "../src/handlers/yahoo-stock-batch.js";
import { yahooStockQuote } from "../src/handlers/yahoo-stock-quote.js";

function buf(o: unknown): Buffer {
  return Buffer.from(JSON.stringify(o));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────
// defillama_stablecoins
// ─────────────────────────────────────────────────────────────────────

describe("defillamaStablecoins", () => {
  it("200 picks top 20 by circulating, sums total", async () => {
    const universe = Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`,
      name: `Stable${i}`,
      symbol: `S${i}`,
      pegType: "peggedUSD",
      pegMechanism: "fiat-backed",
      price: 1.0,
      circulating: { peggedUSD: (30 - i) * 1_000_000 },
      chainCirculating: {
        Ethereum: { current: { peggedUSD: (30 - i) * 600_000 } },
        Tron: { current: { peggedUSD: (30 - i) * 400_000 } },
      },
    }));
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ peggedAssets: universe }), { status: 200 }),
    );
    const res = await defillamaStablecoins({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      universe_size: number;
      top_n: number;
      top_n_total_supply_usd: number;
      stablecoins: Array<{
        symbol: string;
        circulating_usd: number;
        chain_circulating: Record<string, number>;
      }>;
    };
    expect(body.universe_size).toBe(30);
    expect(body.top_n).toBe(20);
    // top-20 sums are arithmetic.
    expect(body.top_n_total_supply_usd).toBeGreaterThan(0);
    // Sorted desc by circulating — first should be the biggest (i=0, 30M).
    expect(body.stablecoins[0].symbol).toBe("S0");
    expect(body.stablecoins[0].circulating_usd).toBe(30_000_000);
    expect(body.stablecoins[0].chain_circulating.Ethereum).toBe(18_000_000);
  });

  it("503 on upstream 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const res = await defillamaStablecoins({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });
});

// ─────────────────────────────────────────────────────────────────────
// yahoo_stock_quote
// ─────────────────────────────────────────────────────────────────────

describe("yahooStockQuote", () => {
  it("400 when symbol missing", async () => {
    const res = await yahooStockQuote({ body: buf({}), method: "POST" });
    expect(res.status).toBe(400);
  });

  it("400 on bogus symbol chars", async () => {
    const res = await yahooStockQuote({
      body: buf({ symbol: "INVALID@FOO" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("404 when upstream returns error envelope", async () => {
    const upstream = { chart: { error: { code: "Not Found" } } };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await yahooStockQuote({
      body: buf({ symbol: "NOPENOPE" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(404);
  });

  it("200 normalizes chart.meta + computes change_pct", async () => {
    const upstream = {
      chart: {
        result: [
          {
            meta: {
              symbol: "AAPL",
              currency: "USD",
              exchangeName: "NMS",
              regularMarketPrice: 200,
              previousClose: 195,
              regularMarketDayHigh: 202,
              regularMarketDayLow: 198,
              regularMarketVolume: 12_345_678,
              fiftyTwoWeekHigh: 220,
              fiftyTwoWeekLow: 150,
              marketState: "REGULAR",
              regularMarketTime: 1_700_000_000,
            },
          },
        ],
        error: null,
      },
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await yahooStockQuote({
      body: buf({ symbol: "AAPL" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      symbol: string;
      price: number;
      previous_close: number;
      change_pct: number;
      market_state: string;
    };
    expect(body.symbol).toBe("AAPL");
    expect(body.price).toBe(200);
    expect(body.change_pct).toBeCloseTo(2.564, 2);
    expect(body.market_state).toBe("REGULAR");
  });
});

// ─────────────────────────────────────────────────────────────────────
// yahoo_stock_batch
// ─────────────────────────────────────────────────────────────────────

describe("yahooStockBatch", () => {
  it("400 when symbols missing", async () => {
    const res = await yahooStockBatch({ body: buf({}), method: "POST" });
    expect(res.status).toBe(400);
  });

  it("400 when more than 50 symbols", async () => {
    const symbols = Array.from({ length: 51 }, (_, i) => `S${i}`);
    const res = await yahooStockBatch({
      body: buf({ symbols }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("200 normalizes quotes + tags missing", async () => {
    const upstream = {
      quoteResponse: {
        result: [
          {
            symbol: "AAPL",
            shortName: "Apple Inc.",
            exchange: "NMS",
            currency: "USD",
            marketState: "REGULAR",
            regularMarketPrice: 200,
            regularMarketChangePercent: 2.5,
            regularMarketVolume: 12_345_678,
            marketCap: 3_000_000_000_000,
          },
        ],
        error: null,
      },
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await yahooStockBatch({
      body: buf({ symbols: ["AAPL", "GHOSTTICKER"] }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      requested: number;
      returned: number;
      missing: string[];
      quotes: Array<{ symbol: string; price: number }>;
    };
    expect(body.requested).toBe(2);
    expect(body.returned).toBe(1);
    expect(body.missing).toEqual(["GHOSTTICKER"]);
    expect(body.quotes[0].symbol).toBe("AAPL");
    expect(body.quotes[0].price).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────
// frankfurter_rates_batch
// ─────────────────────────────────────────────────────────────────────

describe("frankfurterRatesBatch", () => {
  it("400 when symbols missing", async () => {
    const res = await frankfurterRatesBatch({
      body: buf({ base: "USD" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("treats 2-character base as fallback to USD", async () => {
    // Falls back to default USD silently — that's by design (base
    // defaults when length != 3) — so the upstream sees from=USD
    // and returns whatever USD-quoted rates would.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ base: "USD", date: "2026-06-01", rates: { EUR: 0.92 } }),
        { status: 200 },
      ),
    );
    const res = await frankfurterRatesBatch({
      body: buf({ base: "US", symbols: ["EUR"] }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    expect((res.body as { base: string }).base).toBe("USD");
  });

  it("400 on bogus symbol entry that doesn't match /[A-Z]{3}/", async () => {
    const res = await frankfurterRatesBatch({
      body: buf({ base: "USD", symbols: ["EURO"] }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("200 returns rates verbatim, tags missing symbols", async () => {
    const upstream = {
      amount: 1,
      base: "USD",
      date: "2026-06-01",
      rates: { EUR: 0.92, GBP: 0.78 },
    };
    // Default USD base; "EUR" + "GBP" both returned, "JPY" missing.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await frankfurterRatesBatch({
      body: buf({ base: "USD", symbols: ["EUR", "GBP", "JPY"] }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      base: string;
      date: string;
      requested: number;
      returned: number;
      missing: string[];
      rates: Record<string, number>;
    };
    expect(body.base).toBe("USD");
    expect(body.requested).toBe(3);
    expect(body.returned).toBe(2);
    expect(body.missing).toEqual(["JPY"]);
    expect(body.rates.EUR).toBeCloseTo(0.92, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────
// frankfurter_historical
// ─────────────────────────────────────────────────────────────────────

describe("frankfurterHistorical", () => {
  it("400 on missing date", async () => {
    const res = await frankfurterHistorical({
      body: buf({ base: "USD", symbol: "EUR" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("400 on bad date format", async () => {
    const res = await frankfurterHistorical({
      body: buf({ date: "2025/06/01", base: "USD", symbol: "EUR" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("400 on date before coverage", async () => {
    const res = await frankfurterHistorical({
      body: buf({ date: "1998-01-01", base: "USD", symbol: "EUR" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("400 on missing symbol", async () => {
    const res = await frankfurterHistorical({
      body: buf({ date: "2025-01-15", base: "USD" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("200 surfaces rolled_back flag when upstream date differs", async () => {
    const upstream = {
      amount: 1,
      base: "USD",
      date: "2025-01-13", // Monday — upstream rolled back from requested 2025-01-15
      rates: { EUR: 0.95 },
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await frankfurterHistorical({
      body: buf({ date: "2025-01-15", base: "USD", symbol: "EUR" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      requested_date: string;
      effective_date: string;
      rate: number;
      rolled_back: boolean;
    };
    expect(body.requested_date).toBe("2025-01-15");
    expect(body.effective_date).toBe("2025-01-13");
    expect(body.rate).toBeCloseTo(0.95, 4);
    expect(body.rolled_back).toBe(true);
  });
});
