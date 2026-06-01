/**
 * Unit tests for the five new CoinGecko-backed handlers. Each
 * handler is exercised against a stubbed `fetchImpl` — no live
 * network. Coverage matrix per handler:
 *
 *   - input validation failures → 400
 *   - upstream 429 → 503 rate_limit_upstream (the spec'd remap)
 *   - upstream 5xx / non-2xx → 502
 *   - happy path → 200 with normalized body
 *
 * The exact response shapes mirror what CoinGecko Free returns
 * today — verified by spot-call before checking in.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { coingecko24hMovers } from "../src/handlers/coingecko-24h-movers.js";
import { coingeckoMarketRankings } from "../src/handlers/coingecko-market-rankings.js";
import { coingeckoOhlcHistory } from "../src/handlers/coingecko-ohlc-history.js";
import { coingeckoPriceBatch } from "../src/handlers/coingecko-price-batch.js";
import { coingeckoTrending } from "../src/handlers/coingecko-trending.js";

function buf(o: unknown): Buffer {
  return Buffer.from(JSON.stringify(o));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────
// coingecko_price_batch
// ─────────────────────────────────────────────────────────────────────

describe("coingeckoPriceBatch", () => {
  it("400 when ids missing", async () => {
    const res = await coingeckoPriceBatch({ body: buf({}), method: "POST" });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("ids_required");
  });

  it("400 when more than 50 ids", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `coin-${i}`);
    const res = await coingeckoPriceBatch({
      body: buf({ ids }),
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("too_many_ids");
  });

  it("400 when ids contains non-string", async () => {
    const res = await coingeckoPriceBatch({
      body: buf({ ids: ["bitcoin", 123] }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("503 rate_limit_upstream on 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("Too Many Requests", { status: 429 }),
    );
    const res = await coingeckoPriceBatch({
      body: buf({ ids: ["bitcoin"] }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toBe("rate_limit_upstream");
  });

  it("200 happy path normalizes to 8 fields", async () => {
    const upstream = [
      {
        id: "bitcoin",
        symbol: "btc",
        name: "Bitcoin",
        image: "https://...",
        current_price: 65432.1,
        market_cap: 1_200_000_000_000,
        total_volume: 25_000_000_000,
        price_change_percentage_24h: 1.23,
        ath: 73_000,
        last_updated: "2026-06-01T05:00:00.000Z",
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await coingeckoPriceBatch({
      body: buf({ ids: ["bitcoin"] }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      vs_currency: string;
      requested: number;
      returned: number;
      coins: Array<Record<string, unknown>>;
    };
    expect(body.requested).toBe(1);
    expect(body.returned).toBe(1);
    expect(body.coins[0]).toEqual({
      id: "bitcoin",
      symbol: "btc",
      name: "Bitcoin",
      current_price: 65432.1,
      market_cap: 1_200_000_000_000,
      total_volume: 25_000_000_000,
      price_change_percentage_24h: 1.23,
      last_updated: "2026-06-01T05:00:00.000Z",
    });
    // Verify the URL we asked CoinGecko for.
    const url = (fetchImpl.mock.calls[0] as [string])[0];
    expect(url).toContain("/coins/markets");
    expect(url).toContain("ids=bitcoin");
    expect(url).toContain("vs_currency=usd");
  });
});

// ─────────────────────────────────────────────────────────────────────
// coingecko_ohlc_history
// ─────────────────────────────────────────────────────────────────────

describe("coingeckoOhlcHistory", () => {
  it("400 when coin_id missing", async () => {
    const res = await coingeckoOhlcHistory({ body: buf({}), method: "POST" });
    expect(res.status).toBe(400);
  });

  it("400 on invalid coin_id (uppercase or dot)", async () => {
    const res = await coingeckoOhlcHistory({
      body: buf({ coin_id: "Bitcoin.foo" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe(
      "invalid_coin_id_format",
    );
  });

  it("caps days at 365", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    await coingeckoOhlcHistory({
      body: buf({ coin_id: "bitcoin", days: 5000 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const url = (fetchImpl.mock.calls[0] as [string])[0];
    expect(url).toContain("days=365");
  });

  it("404 when coin_id not found upstream", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("Not Found", { status: 404 }),
    );
    const res = await coingeckoOhlcHistory({
      body: buf({ coin_id: "definitely-not-a-coin" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(404);
  });

  it("200 happy path reshapes tuples to named candles", async () => {
    const ts = 1_780_000_000_000;
    const upstream = [
      [ts, 100, 110, 99, 105],
      [ts + 86_400_000, 105, 112, 104, 110],
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await coingeckoOhlcHistory({
      body: buf({ coin_id: "bitcoin", days: 7 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      coin_id: string;
      days: number;
      count: number;
      candles: Array<{
        timestamp: number;
        date_iso: string;
        open: number;
        high: number;
        low: number;
        close: number;
      }>;
    };
    expect(body.coin_id).toBe("bitcoin");
    expect(body.days).toBe(7);
    expect(body.count).toBe(2);
    expect(body.candles[0]).toEqual({
      timestamp: ts,
      date_iso: new Date(ts).toISOString(),
      open: 100,
      high: 110,
      low: 99,
      close: 105,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// coingecko_market_rankings
// ─────────────────────────────────────────────────────────────────────

describe("coingeckoMarketRankings", () => {
  it("200 with empty body — default limit=50 page=1", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    const res = await coingeckoMarketRankings({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const url = (fetchImpl.mock.calls[0] as [string])[0];
    expect(url).toContain("per_page=50");
    expect(url).toContain("page=1");
    expect(url).toContain("price_change_percentage=1h%2C24h%2C7d%2C30d");
  });

  it("caps limit at 250", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    await coingeckoMarketRankings({
      body: buf({ limit: 1000 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const url = (fetchImpl.mock.calls[0] as [string])[0];
    expect(url).toContain("per_page=250");
  });

  it("400 on bogus limit", async () => {
    const res = await coingeckoMarketRankings({
      body: buf({ limit: 0 }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("503 on upstream 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const res = await coingeckoMarketRankings({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });

  it("200 passes through coin array verbatim", async () => {
    const upstream = [{ id: "bitcoin", current_price: 60_000 }];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await coingeckoMarketRankings({
      body: buf({ limit: 5 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const body = res.body as { coins: unknown };
    expect(body.coins).toEqual(upstream);
  });
});

// ─────────────────────────────────────────────────────────────────────
// coingecko_24h_movers
// ─────────────────────────────────────────────────────────────────────

describe("coingecko24hMovers", () => {
  it("400 on negative min_market_cap", async () => {
    const res = await coingecko24hMovers({
      body: buf({ min_market_cap: -1 }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("503 on upstream 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const res = await coingecko24hMovers({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });

  it("buckets top 10 gainers + top 10 losers, filters by market cap", async () => {
    // 15 coins with synthetic 24h moves; the highest mcap (1e10) plus
    // the lowest mcap (1) — the latter must be filtered out by the
    // default 1e7 floor.
    const coins = Array.from({ length: 15 }, (_, i) => ({
      id: `c${i}`,
      symbol: `c${i}`,
      name: `Coin ${i}`,
      current_price: 1,
      market_cap: i === 14 ? 1 : 1e10,
      total_volume: 1,
      // Strictly monotonic — easy to assert ordering deterministically.
      price_change_percentage_24h: i - 7,
    }));
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(coins), { status: 200 }),
    );
    const res = await coingecko24hMovers({
      body: buf({}),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      pool_size: number;
      gainers: Array<{ price_change_percentage_24h: number }>;
      losers: Array<{ price_change_percentage_24h: number }>;
    };
    // 14 of 15 pass the mcap floor.
    expect(body.pool_size).toBe(14);
    expect(body.gainers).toHaveLength(10);
    expect(body.losers).toHaveLength(10);
    // Gainers descending; losers ascending.
    expect(body.gainers[0].price_change_percentage_24h).toBe(6);
    expect(body.losers[0].price_change_percentage_24h).toBe(-7);
  });

  it("respects custom min_market_cap", async () => {
    const coins = [
      {
        id: "big",
        symbol: "big",
        name: "Big",
        current_price: 1,
        market_cap: 1e9,
        total_volume: 1,
        price_change_percentage_24h: 5,
      },
      {
        id: "small",
        symbol: "small",
        name: "Small",
        current_price: 1,
        market_cap: 1e6,
        total_volume: 1,
        price_change_percentage_24h: 99,
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(coins), { status: 200 }),
    );
    const res = await coingecko24hMovers({
      body: buf({ min_market_cap: 1e8 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const body = res.body as {
      pool_size: number;
      gainers: Array<{ id: string }>;
    };
    expect(body.pool_size).toBe(1);
    expect(body.gainers[0].id).toBe("big");
  });
});

// ─────────────────────────────────────────────────────────────────────
// coingecko_trending
// ─────────────────────────────────────────────────────────────────────

describe("coingeckoTrending", () => {
  it("503 on upstream 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const res = await coingeckoTrending({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });

  it("200 unwraps `{coins:[{item:{...}}]}` to flat coins array", async () => {
    const upstream = {
      coins: [
        {
          item: {
            id: "pepe",
            symbol: "PEPE",
            name: "Pepe",
            market_cap_rank: 50,
            thumb: "https://thumb",
            price_btc: 0.0000001,
            score: 0,
          },
        },
        {
          item: {
            id: "doge",
            symbol: "DOGE",
            name: "Dogecoin",
            market_cap_rank: 12,
            thumb: "https://thumb2",
            price_btc: 0.000002,
            score: 1,
          },
        },
      ],
      exchanges: [],
      categories: [],
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await coingeckoTrending({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      count: number;
      coins: Array<{ id: string }>;
    };
    expect(body.count).toBe(2);
    expect(body.coins[0].id).toBe("pepe");
    expect(body.coins[1].id).toBe("doge");
  });

  it("ignores entries missing an `item` envelope", async () => {
    const upstream = {
      coins: [
        { item: { id: "ok", symbol: "OK", name: "OK" } },
        { /* missing item */ },
        null,
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), { status: 200 }),
    );
    const res = await coingeckoTrending({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const body = res.body as { count: number };
    expect(body.count).toBe(1);
  });

  it("400 on garbage body", async () => {
    const res = await coingeckoTrending({
      body: Buffer.from("{not-json"),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });
});
