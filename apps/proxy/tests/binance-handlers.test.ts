/**
 * Unit tests for the three Binance-backed handlers (orderbook,
 * trades, funding). Stubbed against the upstream public-API
 * shapes verified by spot-call before checking in.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { binanceFunding } from "../src/handlers/binance-funding.js";
import { binanceOrderbook } from "../src/handlers/binance-orderbook.js";
import { binanceTrades } from "../src/handlers/binance-trades.js";

function buf(o: unknown): Buffer {
  return Buffer.from(JSON.stringify(o));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────
// binance_orderbook
// ─────────────────────────────────────────────────────────────────────

describe("binanceOrderbook", () => {
  it("400 when symbol missing", async () => {
    const res = await binanceOrderbook({ body: buf({}), method: "POST" });
    expect(res.status).toBe(400);
  });

  it("400 on lowercase symbol", async () => {
    const res = await binanceOrderbook({
      body: buf({ symbol: "btcusdt" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("invalid_symbol_format");
  });

  it("200 returns bids/asks and computes depth + imbalance", async () => {
    const upstream = {
      lastUpdateId: 42,
      bids: [
        ["100.0", "2"],
        ["99.5", "3"],
      ],
      asks: [
        ["101.0", "1"],
        ["101.5", "4"],
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await binanceOrderbook({
      body: buf({ symbol: "BTCUSDT", limit: 5 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      symbol: string;
      bid_depth: number;
      ask_depth: number;
      imbalance_ratio: number;
    };
    expect(body.symbol).toBe("BTCUSDT");
    expect(body.bid_depth).toBe(5);
    expect(body.ask_depth).toBe(5);
    expect(body.imbalance_ratio).toBe(0);
  });

  it("snaps custom limit up to the next Binance step", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ bids: [], asks: [] }), { status: 200 }),
    );
    await binanceOrderbook({
      body: buf({ symbol: "BTCUSDT", limit: 30 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const url = (fetchImpl.mock.calls[0] as [string])[0];
    // 30 → snaps to 50 (next allowed step).
    expect(url).toContain("limit=50");
  });

  it("404 on upstream 400 (Binance returns 400 for unknown symbol)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 400 }));
    const res = await binanceOrderbook({
      body: buf({ symbol: "NOPENOTREAL" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(404);
  });

  it("503 on 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const res = await binanceOrderbook({
      body: buf({ symbol: "BTCUSDT" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });
});

// ─────────────────────────────────────────────────────────────────────
// binance_trades
// ─────────────────────────────────────────────────────────────────────

describe("binanceTrades", () => {
  it("400 when symbol missing", async () => {
    const res = await binanceTrades({ body: buf({}), method: "POST" });
    expect(res.status).toBe(400);
  });

  it("200 flips isBuyerMaker → side string", async () => {
    const upstream = [
      { id: 1, price: "60000", qty: "0.1", quoteQty: "6000", time: 1, isBuyerMaker: true },
      { id: 2, price: "60010", qty: "0.2", quoteQty: "12002", time: 2, isBuyerMaker: false },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await binanceTrades({
      body: buf({ symbol: "BTCUSDT" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const body = res.body as { count: number; trades: Array<{ side: string }> };
    expect(body.count).toBe(2);
    // isBuyerMaker:true means the taker was a SELLER hitting the bid.
    expect(body.trades[0].side).toBe("sell");
    expect(body.trades[1].side).toBe("buy");
  });

  it("503 on 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const res = await binanceTrades({
      body: buf({ symbol: "BTCUSDT" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });
});

// ─────────────────────────────────────────────────────────────────────
// binance_funding
// ─────────────────────────────────────────────────────────────────────

describe("binanceFunding", () => {
  it("400 when symbol missing", async () => {
    const res = await binanceFunding({ body: buf({}), method: "POST" });
    expect(res.status).toBe(400);
  });

  it("200 parses strings to numbers, computes mark_index_spread, funding_rate_pct", async () => {
    const upstream = {
      symbol: "BTCUSDT",
      markPrice: "65432.10",
      indexPrice: "65430.00",
      estimatedSettlePrice: "65431.00",
      lastFundingRate: "0.0001",
      nextFundingTime: 1_800_000_000_000,
      interestRate: "0.0001",
      time: 1_790_000_000_000,
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await binanceFunding({
      body: buf({ symbol: "BTCUSDT" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      mark_price: number;
      index_price: number;
      mark_index_spread: number;
      funding_rate: number;
      funding_rate_pct: number;
    };
    expect(body.mark_price).toBe(65432.1);
    expect(body.index_price).toBe(65430);
    expect(body.mark_index_spread).toBeCloseTo(2.1, 1);
    expect(body.funding_rate).toBeCloseTo(0.0001, 6);
    expect(body.funding_rate_pct).toBeCloseTo(0.01, 6);
  });

  it("503 on 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const res = await binanceFunding({
      body: buf({ symbol: "BTCUSDT" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });

  it("404 when Binance returns 400 (unknown symbol)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 400 }));
    const res = await binanceFunding({
      body: buf({ symbol: "NOPENOPE" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(404);
  });
});
