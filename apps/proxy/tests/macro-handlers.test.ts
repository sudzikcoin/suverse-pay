/**
 * Unit tests for the four "macro" handlers added in this batch:
 * fear-greed (alternative.me), SEC EDGAR filings, Stooq metals,
 * Stooq oil. Each test stubs the upstream `fetchImpl` so no
 * network calls happen during unit-test runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fearGreedIndex } from "../src/handlers/fear-greed-index.js";
import {
  _clearCikCacheForTests,
  _setCikCacheForTests,
  secFilings,
} from "../src/handlers/sec-filings.js";
import { stooqOilPrices } from "../src/handlers/stooq-oil-prices.js";
import { stooqPreciousMetals } from "../src/handlers/stooq-precious-metals.js";

function buf(o: unknown): Buffer {
  return Buffer.from(JSON.stringify(o));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────
// fear_greed_index
// ─────────────────────────────────────────────────────────────────────

describe("fearGreedIndex", () => {
  it("200 normalizes alternative.me payload", async () => {
    const upstream = {
      name: "Fear and Greed Index",
      data: [
        { value: "29", value_classification: "Fear", timestamp: "1780272000", time_until_update: "63630" },
        { value: "28", value_classification: "Fear", timestamp: "1780185600" },
        { value: "55", value_classification: "Greed", timestamp: "1780099200" },
      ],
      metadata: { error: null },
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await fearGreedIndex({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      current_value: number;
      classification: string;
      timestamp: number;
      next_update_seconds: number;
      window_days: number;
      historical: Array<{ value: number }>;
    };
    expect(body.current_value).toBe(29);
    expect(body.classification).toBe("Fear");
    expect(body.timestamp).toBe(1780272000);
    expect(body.next_update_seconds).toBe(63630);
    expect(body.window_days).toBe(3);
    expect(body.historical[2].value).toBe(55);
  });

  it("503 on upstream 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const res = await fearGreedIndex({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });

  it("502 when upstream signals an error in metadata", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ metadata: { error: "rate limit" } }), {
        status: 200,
      }),
    );
    const res = await fearGreedIndex({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(502);
  });
});

// ─────────────────────────────────────────────────────────────────────
// sec_filings
// ─────────────────────────────────────────────────────────────────────

describe("secFilings", () => {
  beforeEach(() => {
    _clearCikCacheForTests();
  });

  it("400 when ticker missing", async () => {
    const res = await secFilings({ body: buf({}), method: "POST" });
    expect(res.status).toBe(400);
  });

  it("400 on bogus ticker chars", async () => {
    const res = await secFilings({
      body: buf({ ticker: "INVALID@FOO" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("404 when ticker missing from CIK map", async () => {
    _setCikCacheForTests([{ ticker: "AAPL", cik: "0000320193", title: "Apple Inc." }]);
    const res = await secFilings({
      body: buf({ ticker: "GHOSTNOPE" }),
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("200 happy path returns normalized filings", async () => {
    _setCikCacheForTests([{ ticker: "AAPL", cik: "0000320193", title: "Apple Inc." }]);
    const upstream = {
      cik: "320193",
      name: "Apple Inc.",
      tickers: ["AAPL"],
      exchanges: ["Nasdaq"],
      filings: {
        recent: {
          accessionNumber: ["0000320193-26-000001", "0000320193-26-000002"],
          filingDate: ["2026-05-30", "2026-05-25"],
          reportDate: ["2026-05-29", "2026-05-24"],
          form: ["10-Q", "8-K"],
          primaryDocument: ["aapl-20260329.htm", "ex991.htm"],
          primaryDocDescription: ["10-Q", "8-K"],
          isXBRL: [1, 0],
        },
      },
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await secFilings({
      body: buf({ ticker: "AAPL", limit: 5 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      ticker: string;
      cik: string;
      name: string;
      count: number;
      filings: Array<{
        form: string;
        filing_date: string;
        accession_number: string;
        filing_url: string;
      }>;
    };
    expect(body.ticker).toBe("AAPL");
    expect(body.cik).toBe("0000320193");
    expect(body.name).toBe("Apple Inc.");
    expect(body.count).toBe(2);
    expect(body.filings[0].form).toBe("10-Q");
    expect(body.filings[0].filing_url).toContain("/Archives/edgar/data/320193/");
    expect(body.filings[0].filing_url).toContain("aapl-20260329.htm");
  });

  it("respects limit (caps internal slice)", async () => {
    _setCikCacheForTests([{ ticker: "AAPL", cik: "0000320193", title: "Apple Inc." }]);
    const upstream = {
      filings: {
        recent: {
          accessionNumber: Array.from({ length: 50 }, (_, i) => `0000320193-26-${String(i).padStart(6, "0")}`),
          filingDate: Array(50).fill("2026-05-30"),
          reportDate: Array(50).fill("2026-05-29"),
          form: Array(50).fill("4"),
          primaryDocument: Array(50).fill("xslF345X05/wf-form4_x.xml"),
          primaryDocDescription: Array(50).fill("Form 4"),
          isXBRL: Array(50).fill(0),
        },
      },
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await secFilings({
      body: buf({ ticker: "AAPL", limit: 3 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const body = res.body as { count: number };
    expect(body.count).toBe(3);
  });

  it("503 on upstream 429", async () => {
    _setCikCacheForTests([{ ticker: "AAPL", cik: "0000320193" }]);
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const res = await secFilings({
      body: buf({ ticker: "AAPL" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });
});

// ─────────────────────────────────────────────────────────────────────
// stooq_precious_metals
// ─────────────────────────────────────────────────────────────────────

describe("stooqPreciousMetals", () => {
  it("200 parses four-symbol CSV into metals array", async () => {
    const csv =
      "Symbol,Date,Time,Open,High,Low,Close,Volume,Name\n" +
      "XAUUSD,2026-06-01,08:00:00,4523.02,4545.72,4509.38,4514.06,,XAU/USD\n" +
      "XAGUSD,2026-06-01,08:00:00,74.10,76.04,74.10,75.70,,XAG/USD\n" +
      "XPTUSD,2026-06-01,08:00:00,1916,1952,1914,1945,,XPT/USD\n" +
      "XPDUSD,2026-06-01,08:00:00,950,975,940,968,,XPD/USD\n";
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(csv, { status: 200, headers: { "content-type": "text/csv" } }),
    );
    const res = await stooqPreciousMetals({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      count: number;
      currency: string;
      unit: string;
      metals: Array<{ symbol: string; metal: string; close: number }>;
    };
    expect(body.count).toBe(4);
    expect(body.currency).toBe("USD");
    expect(body.unit).toBe("troy_ounce");
    expect(body.metals[0]).toMatchObject({
      symbol: "XAUUSD",
      metal: "gold",
      close: 4514.06,
    });
    expect(body.metals[1].metal).toBe("silver");
    expect(body.metals[2].metal).toBe("platinum");
    expect(body.metals[3].metal).toBe("palladium");
  });

  it("handles N/D upstream values as nulls", async () => {
    const csv =
      "Symbol,Date,Time,Open,High,Low,Close,Volume,Name\n" +
      "XAUUSD,N/D,N/D,N/D,N/D,N/D,N/D,N/D,XAU/USD\n";
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(csv, { status: 200 }),
    );
    const res = await stooqPreciousMetals({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const body = res.body as { metals: Array<{ close: number | null; date: string | null }> };
    expect(body.metals[0].close).toBeNull();
    expect(body.metals[0].date).toBeNull();
  });

  it("503 on upstream 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const res = await stooqPreciousMetals({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });
});

// ─────────────────────────────────────────────────────────────────────
// stooq_oil_prices
// ─────────────────────────────────────────────────────────────────────

describe("stooqOilPrices", () => {
  it("200 parses both benchmarks and computes brent_wti_spread", async () => {
    const csv =
      "Symbol,Date,Time,Open,High,Low,Close,Volume,Name\n" +
      "CL.F,2026-06-01,08:00:00,88.95,90.11,88.78,90.03,,CRUDE OIL WTI\n" +
      "CB.F,2026-06-01,08:00:00,92.53,93.69,92.48,93.59,,CRUDE OIL BRENT\n";
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(csv, { status: 200 }),
    );
    const res = await stooqOilPrices({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      wti: { close: number };
      brent: { close: number };
      brent_wti_spread: number;
      count: number;
    };
    expect(body.wti.close).toBe(90.03);
    expect(body.brent.close).toBe(93.59);
    expect(body.brent_wti_spread).toBeCloseTo(3.56, 2);
    expect(body.count).toBe(2);
  });

  it("503 on upstream 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const res = await stooqOilPrices({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });

  it("400 on garbage body", async () => {
    const res = await stooqOilPrices({
      body: Buffer.from("{nope"),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });
});
