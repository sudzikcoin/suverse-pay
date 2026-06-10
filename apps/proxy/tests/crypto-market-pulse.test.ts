import { describe, expect, it } from "vitest";
import {
  bucketSentiment,
  crossCheckTrending,
  cryptoMarketPulse,
  cryptoMarketPulsePreflight,
  cryptoMarketPulseValidator,
  deriveConfidence,
  deriveDirection,
  deriveRegime,
  filterPolymarketSignals,
  type NetflowByChain,
  type NetflowTokenRow,
} from "../src/handlers/crypto-market-pulse.js";
import type { DbQuerier } from "../src/handlers/types.js";

// ─────────────────────────────────────────────────────────────────────
// Stub upstreams
// ─────────────────────────────────────────────────────────────────────

const FNG_UPSTREAM = {
  name: "Fear and Greed Index",
  data: [
    {
      value: "9",
      value_classification: "Extreme Fear",
      timestamp: "1781049600",
      time_until_update: "30671",
    },
    { value: "10", value_classification: "Extreme Fear", timestamp: "1780963200" },
  ],
  metadata: { error: null },
};

const TRENDING_UPSTREAM = {
  coins: [
    ...["HYPE", "BORK", "WIF", "PEPE", "TURBO", "MOG", "BRETT", "EIGHTH"].map(
      (symbol, i) => ({
        item: {
          id: symbol.toLowerCase(),
          symbol,
          name: symbol,
          market_cap_rank: i + 1,
          thumb: "",
          price_btc: 0.0001,
          score: i,
        },
      }),
    ),
  ],
};

const POLY_UPSTREAM = {
  data: [
    { market_id: "0xaaa", market_title: "A", category: "crypto", conviction_score: 67.4, bias_score: -100, smart_yes_volume_usd: 0, smart_no_volume_usd: 374 },
    { market_id: "0xbbb", market_title: "B", category: "politics", conviction_score: 55.1, bias_score: 100, smart_yes_volume_usd: 10, smart_no_volume_usd: 0 },
    { market_id: "0xccc", market_title: "C", category: "macro", conviction_score: 71.0, bias_score: 100, smart_yes_volume_usd: 900, smart_no_volume_usd: 1 },
    { market_id: "0xddd", market_title: "D", category: "crypto", conviction_score: 60.0, bias_score: -100, smart_yes_volume_usd: 2, smart_no_volume_usd: 8 },
    { market_id: "0xeee", market_title: "E", category: "crypto", conviction_score: 64.2, bias_score: 100, smart_yes_volume_usd: 50, smart_no_volume_usd: 3 },
  ],
};

interface FetchOverrides {
  fng?: () => Response;
  trending?: () => Response;
  btc?: () => Response;
  coinbase?: () => Response;
  poly?: () => Response;
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeFetchStub(overrides: FetchOverrides = {}): typeof fetch {
  return (async (url: unknown) => {
    const u = String(url);
    if (u.includes("alternative.me")) {
      return overrides.fng ? overrides.fng() : ok(FNG_UPSTREAM);
    }
    if (u.includes("search/trending")) {
      return overrides.trending ? overrides.trending() : ok(TRENDING_UPSTREAM);
    }
    if (u.includes("simple/price")) {
      return overrides.btc
        ? overrides.btc()
        : ok({ bitcoin: { usd: 62000, usd_24h_change: -1.456 } });
    }
    if (u.includes("coinbase.com")) {
      return overrides.coinbase
        ? overrides.coinbase()
        : ok({ data: { amount: "62100.50", base: "BTC", currency: "USD" } });
    }
    if (u.includes("smart-bias")) {
      return overrides.poly ? overrides.poly() : ok(POLY_UPSTREAM);
    }
    throw new Error(`unexpected url in test: ${u}`);
  }) as typeof fetch;
}

/**
 * DB stub keyed by `${chain}:${window}` — the window is recovered from
 * the windowStart param the SQL receives ($6).
 */
function makeDbStub(
  rowsByKey: Partial<Record<string, Array<Record<string, unknown>>>>,
  opts: { throwOn?: string } = {},
): DbQuerier {
  return {
    query: async (_sql: string, params?: unknown[]) => {
      const chain = String(params?.[0]);
      const windowStart = params?.[5] as Date;
      const hours = (Date.now() - windowStart.getTime()) / 3_600_000;
      const window = hours < 100 ? "24h" : "7d";
      const key = `${chain}:${window}`;
      if (opts.throwOn && key.startsWith(opts.throwOn)) {
        throw new Error("connection refused");
      }
      return { rows: rowsByKey[key] ?? [] };
    },
  };
}

function flowRow(
  token: string,
  symbol: string | null,
  net: number,
  score: number,
): Record<string, unknown> {
  return {
    token_address: token,
    symbol,
    net_flow_usd: net,
    gross_flow_usd: Math.abs(net) * 3,
    smart_money_score: score,
    trade_count: 10,
  };
}

/** 12 eligible solana tokens, strongly net-positive 24h — inflow. */
function healthyRows(): Partial<Record<string, Array<Record<string, unknown>>>> {
  const solana24 = Array.from({ length: 12 }, (_, i) =>
    flowRow(`mintS${i}`, i === 0 ? "HYPE" : `TOK${i}`, 100, 80),
  );
  const solana7d = Array.from({ length: 12 }, (_, i) =>
    flowRow(`mintS${i}`, i === 0 ? "HYPE" : `TOK${i}`, 200, 80),
  );
  return {
    "solana:24h": [...solana24, flowRow("lowScore", "LOW", 9999, 50)],
    "solana:7d": solana7d,
    "base:24h": [flowRow("mintB0", "BORK", -50, 75)],
    "base:7d": [flowRow("mintB0", "BORK", -80, 75)],
  };
}

// ─────────────────────────────────────────────────────────────────────
// Pure verdict logic
// ─────────────────────────────────────────────────────────────────────

describe("bucketSentiment", () => {
  it.each([
    ["Extreme Fear", "fear"],
    ["Fear", "fear"],
    ["Neutral", "neutral"],
    ["Greed", "greed"],
    ["Extreme Greed", "greed"],
    ["???", "neutral"],
    [null, "neutral"],
  ] as const)("%s -> %s", (input, expected) => {
    expect(bucketSentiment(input)).toBe(expected);
  });
});

describe("deriveRegime — full 3x3 grid", () => {
  it.each([
    ["fear", "inflow", "accumulation_on_fear"],
    ["fear", "outflow", "capitulation"],
    ["fear", "neutral", "mixed"],
    ["neutral", "inflow", "mixed"],
    ["neutral", "outflow", "mixed"],
    ["neutral", "neutral", "mixed"],
    ["greed", "inflow", "confirmed_rally"],
    ["greed", "outflow", "late_stage_caution"],
    ["greed", "neutral", "mixed"],
  ] as const)("%s + %s -> %s", (sentiment, direction, regime) => {
    expect(deriveRegime(sentiment, direction)).toBe(regime);
  });
});

describe("deriveDirection — pace logic", () => {
  it("inflow when 24h positive and accelerating vs 7d daily pace", () => {
    // pace24 = 1200/24 = 50; pace7d = 2400/168 = 14.3
    expect(deriveDirection(1200, 2400).direction).toBe("inflow");
  });
  it("neutral when 24h positive but decelerating", () => {
    // pace24 = 24/24 = 1; pace7d = 8400/168 = 50
    expect(deriveDirection(24, 8400).direction).toBe("neutral");
  });
  it("outflow when 24h negative and |pace| >= 7d pace", () => {
    // pace24 = -50; |pace24| = 50 >= pace7d = -10/168
    expect(deriveDirection(-1200, -10).direction).toBe("outflow");
  });
  it("neutral when 24h negative but 7d inflow pace dominates", () => {
    // |pace24| = 1 < pace7d = 16800/168 = 100
    expect(deriveDirection(-24, 16800).direction).toBe("neutral");
  });
  it("neutral on exactly zero 24h flow", () => {
    expect(deriveDirection(0, 5000).direction).toBe("neutral");
  });
  it("reports pace in USD/hour", () => {
    const { pace24h, pace7d } = deriveDirection(2400, 16800);
    expect(pace24h).toBe(100);
    expect(pace7d).toBe(100);
  });
});

describe("filterPolymarketSignals — conviction gate", () => {
  it("keeps only conviction >= 60, top 3 by conviction desc", () => {
    const out = filterPolymarketSignals(POLY_UPSTREAM.data);
    expect(out.map((m) => m.market_id)).toEqual(["0xccc", "0xaaa", "0xeee"]);
  });
  it("60.0 exactly passes the gate when fewer than 3 better markets", () => {
    const out = filterPolymarketSignals([
      { market_id: "x", conviction_score: 60.0 },
      { market_id: "y", conviction_score: 59.99 },
    ]);
    expect(out.map((m) => m.market_id)).toEqual(["x"]);
  });
  it("ignores bias_score entirely (bimodal at ±100)", () => {
    const out = filterPolymarketSignals([
      { market_id: "x", conviction_score: 80, bias_score: 0 },
      { market_id: "y", conviction_score: 30, bias_score: 100 },
    ]);
    expect(out.map((m) => m.market_id)).toEqual(["x"]);
  });
  it("empty input -> empty output", () => {
    expect(filterPolymarketSignals([])).toEqual([]);
  });
});

describe("crossCheckTrending", () => {
  const netflow = (rows: NetflowTokenRow[]): NetflowByChain => ({
    solana: {
      "24h": { rows, eligible_sum_net_flow_usd: 0, eligible_row_count: 0 },
      "7d": { rows: [], eligible_sum_net_flow_usd: 0, eligible_row_count: 0 },
    },
    base: {
      "24h": { rows: [], eligible_sum_net_flow_usd: 0, eligible_row_count: 0 },
      "7d": { rows: [], eligible_sum_net_flow_usd: 0, eligible_row_count: 0 },
    },
  });

  it("confirms only symbols with positive net flow, case-insensitive", () => {
    const rows: NetflowTokenRow[] = [
      { token_address: "a", symbol: "hype", net_flow_usd: 10, gross_flow_usd: 10, smart_money_score: 80, trade_count: 1 },
      { token_address: "b", symbol: "BORK", net_flow_usd: -10, gross_flow_usd: 10, smart_money_score: 80, trade_count: 1 },
    ];
    const out = crossCheckTrending(
      [
        { symbol: "HYPE" },
        { symbol: "BORK" },
        { symbol: "WIF" },
      ],
      netflow(rows),
    );
    expect(out.map((c) => c.confirmed)).toEqual([true, false, false]);
  });

  it("caps at top 7 trending coins", () => {
    const coins = Array.from({ length: 10 }, (_, i) => ({ symbol: `S${i}` }));
    expect(crossCheckTrending(coins, netflow([]))).toHaveLength(7);
  });
});

describe("deriveConfidence", () => {
  it("high: nothing failed, >= 10 eligible solana rows", () => {
    expect(deriveConfidence([], 12)).toBe("high");
  });
  it("medium: nothing failed but thin solana coverage", () => {
    expect(deriveConfidence([], 9)).toBe("medium");
  });
  it("medium: one failed source with good coverage", () => {
    expect(deriveConfidence(["trending"], 12)).toBe("medium");
  });
  it("low: one failed source + thin coverage", () => {
    expect(deriveConfidence(["trending"], 3)).toBe("low");
  });
  it("low: two failed sources", () => {
    expect(deriveConfidence(["trending", "polymarket"], 12)).toBe("low");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Validator
// ─────────────────────────────────────────────────────────────────────

describe("cryptoMarketPulseValidator", () => {
  it("accepts empty body", () => {
    expect(cryptoMarketPulseValidator(null, "POST")).toBeNull();
    expect(cryptoMarketPulseValidator(Buffer.alloc(0), "POST")).toBeNull();
  });
  it("accepts a JSON object", () => {
    expect(cryptoMarketPulseValidator(Buffer.from("{}"), "POST")).toBeNull();
  });
  it("rejects a JSON array", () => {
    const res = cryptoMarketPulseValidator(Buffer.from("[1,2]"), "POST");
    expect(res?.status).toBe(400);
  });
  it("rejects malformed JSON", () => {
    const res = cryptoMarketPulseValidator(Buffer.from("{nope"), "POST");
    expect(res?.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Preflight — fail-closed gate
// ─────────────────────────────────────────────────────────────────────

describe("cryptoMarketPulsePreflight", () => {
  it("proceeds with data when both critical sources are healthy", async () => {
    const pf = await cryptoMarketPulsePreflight({
      body: null,
      method: "POST",
      fetchImpl: makeFetchStub(),
      db: makeDbStub(healthyRows()),
    });
    expect(pf.proceed).toBe(true);
    if (pf.proceed) expect(pf.data).toBeDefined();
  });

  it("refuses (503) when fear-greed upstream is down", async () => {
    const pf = await cryptoMarketPulsePreflight({
      body: null,
      method: "POST",
      fetchImpl: makeFetchStub({
        fng: () => new Response("", { status: 500 }),
      }),
      db: makeDbStub(healthyRows()),
    });
    expect(pf.proceed).toBe(false);
    if (!pf.proceed) {
      expect(pf.status).toBe(503);
      expect((pf.body as { source: string }).source).toBe("fear_greed");
    }
  });

  it("refuses (503) when the netflow query throws", async () => {
    const pf = await cryptoMarketPulsePreflight({
      body: null,
      method: "POST",
      fetchImpl: makeFetchStub(),
      db: makeDbStub(healthyRows(), { throwOn: "solana" }),
    });
    expect(pf.proceed).toBe(false);
    if (!pf.proceed) {
      expect(pf.status).toBe(503);
      expect((pf.body as { source: string }).source).toBe(
        "smart_money_netflow",
      );
    }
  });

  it("refuses when no db is wired (misconfiguration is fail-closed too)", async () => {
    const pf = await cryptoMarketPulsePreflight({
      body: null,
      method: "POST",
      fetchImpl: makeFetchStub(),
    });
    expect(pf.proceed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Full handler
// ─────────────────────────────────────────────────────────────────────

interface PulseBody {
  verdict: { regime: string; summary: string; confidence: string };
  signals: {
    sentiment: { value: number; classification: string; bucket: string };
    smart_money: Record<
      string,
      { direction: string; regime: string; coverage_level: string }
    >;
    trending: Array<{ symbol: string | null; confirmed: boolean }>;
    btc: { price_usd: number; change_24h_pct: number | null; source: string } | null;
    polymarket: Array<{ market_id: string | null; conviction_score: number | null }>;
  };
  data_quality: {
    solana: string;
    base: string;
    stale_sources: string[];
    computed_at: string;
  };
  raw: Record<string, unknown>;
}

describe("cryptoMarketPulse — happy path", () => {
  it("returns the three-layer verdict with high confidence", async () => {
    const res = await cryptoMarketPulse({
      body: Buffer.from("{}"),
      method: "POST",
      fetchImpl: makeFetchStub(),
      db: makeDbStub(healthyRows()),
    });
    expect(res.status).toBe(200);
    const body = res.body as PulseBody;

    // Verdict: Extreme Fear + solana inflow (1200 vs 2400/7d).
    expect(body.verdict.regime).toBe("accumulation_on_fear");
    expect(body.verdict.confidence).toBe("high");
    expect(body.verdict.summary).toContain("Extreme Fear");

    // Signals.
    expect(body.signals.sentiment.bucket).toBe("fear");
    expect(body.signals.smart_money["solana"]!.direction).toBe("inflow");
    expect(body.signals.smart_money["solana"]!.coverage_level).toBe(
      "production",
    );
    // Base: -50 in 24h, |pace| dominates -> capitulation per-chain.
    expect(body.signals.smart_money["base"]!.direction).toBe("outflow");
    expect(body.signals.smart_money["base"]!.regime).toBe("capitulation");

    // Trending: HYPE has positive netflow -> confirmed; 7 coins max.
    expect(body.signals.trending).toHaveLength(7);
    expect(body.signals.trending[0]).toMatchObject({
      symbol: "HYPE",
      confirmed: true,
    });
    expect(body.signals.trending[2]).toMatchObject({ confirmed: false });

    // BTC via CoinGecko including the delta.
    expect(body.signals.btc).toMatchObject({
      price_usd: 62000,
      change_24h_pct: -1.46,
      source: "coingecko",
    });

    // Polymarket: conviction >= 60 only, top 3.
    expect(body.signals.polymarket.map((m) => m.market_id)).toEqual([
      "0xccc",
      "0xaaa",
      "0xeee",
    ]);

    // Data quality + raw.
    expect(body.data_quality.stale_sources).toEqual([]);
    expect(body.data_quality.solana).toBe("production");
    expect(body.raw["fear_greed"]).toBeDefined();
    expect(body.raw["smart_money_netflow"]).toBeDefined();
  });

  it("excludes sub-70-score tokens from the axis sum but keeps high confidence", async () => {
    // healthyRows includes a score-50 token with +9999 flow; if it
    // leaked into the sum the pace numbers would be wildly different.
    const res = await cryptoMarketPulse({
      body: null,
      method: "POST",
      fetchImpl: makeFetchStub(),
      db: makeDbStub(healthyRows()),
    });
    const body = res.body as PulseBody;
    const sol = body.signals.smart_money["solana"] as unknown as {
      sum_net_flow_usd_24h: number;
    };
    expect(sol.sum_net_flow_usd_24h).toBe(1200);
  });
});

describe("cryptoMarketPulse — partial failure degradation", () => {
  it("omits trending, lists it stale, degrades to medium", async () => {
    const res = await cryptoMarketPulse({
      body: null,
      method: "POST",
      fetchImpl: makeFetchStub({
        trending: () => new Response("", { status: 500 }),
      }),
      db: makeDbStub(healthyRows()),
    });
    expect(res.status).toBe(200);
    const body = res.body as PulseBody;
    expect(body.signals.trending).toEqual([]);
    expect(body.data_quality.stale_sources).toEqual(["trending"]);
    expect(body.verdict.confidence).toBe("medium");
    expect(body.raw["trending"]).toBeNull();
  });

  it("falls back to Coinbase spot when CoinGecko fails (partial: no delta)", async () => {
    const res = await cryptoMarketPulse({
      body: null,
      method: "POST",
      fetchImpl: makeFetchStub({
        btc: () => new Response("", { status: 429 }),
      }),
      db: makeDbStub(healthyRows()),
    });
    const body = res.body as PulseBody;
    expect(body.signals.btc).toMatchObject({
      price_usd: 62100.5,
      change_24h_pct: null,
      source: "coinbase_spot",
    });
    expect(body.data_quality.stale_sources).toEqual(["btc_24h_change"]);
    expect(body.verdict.confidence).toBe("medium");
  });

  it("two failed sources -> low confidence, verdict still served", async () => {
    const res = await cryptoMarketPulse({
      body: null,
      method: "POST",
      fetchImpl: makeFetchStub({
        trending: () => new Response("", { status: 500 }),
        poly: () => new Response("", { status: 500 }),
      }),
      db: makeDbStub(healthyRows()),
    });
    expect(res.status).toBe(200);
    const body = res.body as PulseBody;
    expect(body.verdict.confidence).toBe("low");
    expect(body.data_quality.stale_sources).toEqual([
      "trending",
      "polymarket",
    ]);
    expect(body.verdict.regime).toBe("accumulation_on_fear");
  });
});

describe("cryptoMarketPulse — fail-closed without preflight data", () => {
  it("503s when fear-greed is down (direct invocation path)", async () => {
    const res = await cryptoMarketPulse({
      body: null,
      method: "POST",
      fetchImpl: makeFetchStub({
        fng: () => new Response("", { status: 500 }),
      }),
      db: makeDbStub(healthyRows()),
    });
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toBe(
      "critical_source_unavailable",
    );
  });

  it("503s when the db is unavailable", async () => {
    const res = await cryptoMarketPulse({
      body: null,
      method: "POST",
      fetchImpl: makeFetchStub(),
      db: makeDbStub({}, { throwOn: "base" }),
    });
    expect(res.status).toBe(503);
  });

  it("reuses preflight data instead of recomputing", async () => {
    let dbCalls = 0;
    const countingDb: DbQuerier = {
      query: async (...argsIn: [string, unknown[]?]) => {
        dbCalls += 1;
        return makeDbStub(healthyRows()).query(...argsIn);
      },
    };
    const pf = await cryptoMarketPulsePreflight({
      body: null,
      method: "POST",
      fetchImpl: makeFetchStub(),
      db: countingDb,
    });
    expect(pf.proceed).toBe(true);
    const callsAfterPreflight = dbCalls;
    const res = await cryptoMarketPulse({
      body: null,
      method: "POST",
      fetchImpl: makeFetchStub(),
      db: countingDb,
      preflightData: pf.proceed ? pf.data : undefined,
    });
    expect(res.status).toBe(200);
    expect(dbCalls).toBe(callsAfterPreflight); // no second netflow pass
  });
});
