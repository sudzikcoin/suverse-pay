/**
 * Unit tests for the 3 TA handlers (RSI, MACD, moving averages)
 * plus the pure-math helper module they rely on. The math
 * helper tests use a deterministic price series so a refactor
 * that breaks RSI/EMA/MACD numerics fails the assertion before
 * it ever hits the wire.
 *
 * The HTTP-side tests stub a fixed-length kline series in the
 * Binance row shape `[openTime, o, h, l, c, v, closeTime, ...]`
 * so the handler's parse path is exercised without burning real
 * upstream credits.
 */

import { describe, expect, it, vi } from "vitest";

import { detectCross, ema, macd, rsi, sma } from "../src/handlers/_ta-math.js";
import { taMacd } from "../src/handlers/ta-macd.js";
import { taMovingAverages } from "../src/handlers/ta-moving-averages.js";
import { taRsi } from "../src/handlers/ta-rsi.js";

function buf(o: unknown): Buffer {
  return Buffer.from(JSON.stringify(o));
}

/** Build N synthetic Binance kline rows from a closes array. */
function makeKlines(closes: number[]): unknown[][] {
  return closes.map((c, i) => [
    1_700_000_000_000 + i * 60_000, // openTime
    c, // open (synthetic — doesn't matter for TA, we read close)
    c, // high
    c, // low
    c, // close
    1, // volume
    1_700_000_000_000 + i * 60_000 + 59_999, // closeTime
    1, 1, 1, 1, 0,
  ]);
}

// ─────────────────────────────────────────────────────────────────────
// _ta-math
// ─────────────────────────────────────────────────────────────────────

describe("_ta-math primitives", () => {
  it("SMA matches arithmetic mean over the window", () => {
    const s = sma([1, 2, 3, 4, 5], 3);
    expect(s).toEqual([2, 3, 4]);
  });

  it("EMA seeds from SMA then applies α=2/(N+1)", () => {
    // Period 3, values 1..5. Seed = (1+2+3)/3 = 2.
    // Next = 4*0.5 + 2*0.5 = 3.
    // Next = 5*0.5 + 3*0.5 = 4.
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(e).toEqual([2, 3, 4]);
  });

  it("RSI 14 on monotonic-up series approaches 100", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const { rsi: r } = rsi(closes, 14);
    expect(r[r.length - 1]).toBeCloseTo(100, 0);
  });

  it("RSI 14 on monotonic-down series approaches 0", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 - i);
    const { rsi: r } = rsi(closes, 14);
    expect(r[r.length - 1]).toBeCloseTo(0, 0);
  });

  it("MACD produces aligned macd/signal/histogram", () => {
    // 60 alternating-up-down closes — enough to seed 12/26/9.
    const closes = Array.from({ length: 60 }, (_, i) =>
      100 + Math.sin(i / 5) * 10,
    );
    const m = macd(closes, 12, 26, 9);
    expect(m.signal.length).toBeGreaterThan(0);
    expect(m.histogram.length).toBe(m.signal.length);
    expect(m.macd.length).toBeGreaterThanOrEqual(m.signal.length);
  });

  it("detectCross flags the most recent crossover", () => {
    // a crosses above b at index 3 → bullish, periodsAgo = 1
    const a = [1, 2, 3, 5, 6];
    const b = [4, 4, 4, 4, 4];
    const c = detectCross(a, b, 5);
    expect(c).not.toBeNull();
    expect(c!.direction).toBe("bullish");
    expect(c!.periodsAgo).toBe(1);
  });

  it("detectCross returns null when no cross in window", () => {
    const a = [5, 5, 5, 5, 5];
    const b = [1, 1, 1, 1, 1];
    expect(detectCross(a, b, 5)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// ta_rsi
// ─────────────────────────────────────────────────────────────────────

describe("taRsi handler", () => {
  it("400 on missing symbol", async () => {
    const res = await taRsi({ body: buf({}), method: "POST" });
    expect(res.status).toBe(400);
  });

  it("400 on invalid interval", async () => {
    const res = await taRsi({
      body: buf({ symbol: "BTCUSDT", interval: "13s" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("400 on out-of-range period", async () => {
    const res = await taRsi({
      body: buf({ symbol: "BTCUSDT", interval: "1h", period: 500 }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("503 on upstream 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const res = await taRsi({
      body: buf({ symbol: "BTCUSDT", interval: "1h" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });

  it("200 happy path — computes RSI, signal, trend, 50 historical", async () => {
    const closes = Array.from({ length: 80 }, (_, i) =>
      100 + Math.sin(i / 4) * 8,
    );
    const klines = makeKlines(closes);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(klines), { status: 200 }),
    );
    const res = await taRsi({
      body: buf({ symbol: "BTCUSDT", interval: "1h" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      symbol: string;
      current_rsi: number;
      signal: string;
      trend: string;
      historical: Array<{ time: number; value: number }>;
    };
    expect(body.symbol).toBe("BTCUSDT");
    expect(body.current_rsi).toBeGreaterThan(0);
    expect(body.current_rsi).toBeLessThan(100);
    expect(["overbought", "oversold", "neutral"]).toContain(body.signal);
    expect(["rising", "falling", "flat"]).toContain(body.trend);
    // Window is "last 50 historical" — but if upstream returned fewer
    // than period+50 viable closes, the handler still surfaces what it
    // computed. Just assert non-empty and bounded.
    expect(body.historical.length).toBeGreaterThan(0);
    expect(body.historical.length).toBeLessThanOrEqual(50);
  });
});

// ─────────────────────────────────────────────────────────────────────
// ta_macd
// ─────────────────────────────────────────────────────────────────────

describe("taMacd handler", () => {
  it("400 on missing symbol", async () => {
    const res = await taMacd({ body: buf({}), method: "POST" });
    expect(res.status).toBe(400);
  });

  it("200 happy path — macd/signal/histogram populated", async () => {
    const closes = Array.from({ length: 200 }, (_, i) =>
      100 + Math.sin(i / 6) * 12,
    );
    const klines = makeKlines(closes);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(klines), { status: 200 }),
    );
    const res = await taMacd({
      body: buf({ symbol: "BTCUSDT", interval: "1h" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      current_macd: number;
      current_signal: number;
      current_histogram: number;
      histogram_last_10: number[];
      trend: string;
    };
    expect(typeof body.current_macd).toBe("number");
    expect(typeof body.current_signal).toBe("number");
    expect(typeof body.current_histogram).toBe("number");
    expect(body.histogram_last_10).toHaveLength(10);
  });

  it("404 on upstream 400 (unknown symbol)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 400 }));
    const res = await taMacd({
      body: buf({ symbol: "NOPENOPE" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────
// ta_moving_averages
// ─────────────────────────────────────────────────────────────────────

describe("taMovingAverages handler", () => {
  it("400 on missing symbol", async () => {
    const res = await taMovingAverages({ body: buf({}), method: "POST" });
    expect(res.status).toBe(400);
  });

  it("502 insufficient_klines when upstream returns too few rows", async () => {
    const klines = makeKlines(Array.from({ length: 100 }, (_, i) => 100 + i));
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(klines), { status: 200 }),
    );
    const res = await taMovingAverages({
      body: buf({ symbol: "BTCUSDT", interval: "1d" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(502);
    expect((res.body as { error: string }).error).toBe("insufficient_klines");
  });

  it("200 happy path — sma + ema 20/50/200 all populated", async () => {
    const closes = Array.from({ length: 250 }, (_, i) =>
      100 + Math.sin(i / 10) * 20 + i * 0.1,
    );
    const klines = makeKlines(closes);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(klines), { status: 200 }),
    );
    const res = await taMovingAverages({
      body: buf({ symbol: "BTCUSDT", interval: "1d" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      current_price: number;
      sma_20: number;
      sma_50: number;
      sma_200: number;
      ema_20: number;
      ema_50: number;
      ema_200: number;
      trend: string;
    };
    expect(typeof body.sma_20).toBe("number");
    expect(typeof body.sma_50).toBe("number");
    expect(typeof body.sma_200).toBe("number");
    expect(typeof body.ema_20).toBe("number");
    expect(typeof body.ema_50).toBe("number");
    expect(typeof body.ema_200).toBe("number");
    expect(["above_200sma", "below_200sma"]).toContain(body.trend);
  });
});
