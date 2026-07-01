import { describe, expect, it } from "vitest";
import {
  buildRegimeResponse,
  classifyRegime,
  marketRegimeVerdict,
  marketRegimeVerdictInputSchema,
  marketRegimeVerdictPreflight,
  marketRegimeVerdictValidator,
  REGIME_WEIGHTS,
} from "../src/handlers/market-regime-verdict.js";
import type { DbQuerier } from "../src/handlers/types.js";

// ─────────────────────────────────────────────────────────────────────
// Stub upstreams — pulse fixtures mirror crypto-market-pulse.test.ts
// (copied, NOT imported — that file stays untouched), extended with
// the two driver upstreams (Binance premiumIndex + DeFiLlama).
// ─────────────────────────────────────────────────────────────────────

function fng(value: number, classification: string): unknown {
  return {
    name: "Fear and Greed Index",
    data: [
      {
        value: String(value),
        value_classification: classification,
        timestamp: "1781049600",
        time_until_update: "30671",
      },
    ],
    metadata: { error: null },
  };
}

const TRENDING_UPSTREAM = {
  coins: [
    ...["HYPE", "BORK", "WIF", "PEPE", "TURBO", "MOG", "BRETT"].map(
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
    {
      market_id: "0xccc",
      market_title: "C",
      category: "macro",
      conviction_score: 71.0,
      bias_score: 100,
      smart_yes_volume_usd: 900,
      smart_no_volume_usd: 1,
    },
  ],
};

const FUNDING_UPSTREAM = [
  {
    symbol: "BTCUSDT",
    markPrice: "62000.00",
    indexPrice: "61990.00",
    lastFundingRate: "0.00030000",
    nextFundingTime: 1_780_000_000_000,
    time: 1_779_999_000_000,
  },
  {
    symbol: "ETHUSDT",
    markPrice: "3200.00",
    indexPrice: "3199.00",
    lastFundingRate: "0.00050000",
    nextFundingTime: 1_780_000_000_000,
    time: 1_779_999_000_000,
  },
  { symbol: "DOGEUSDT", lastFundingRate: "0.00010000" },
];

const FUNDING_BEARISH = FUNDING_UPSTREAM.map((r) =>
  r.symbol === "BTCUSDT"
    ? { ...r, lastFundingRate: "-0.00030000" }
    : r.symbol === "ETHUSDT"
      ? { ...r, lastFundingRate: "-0.00050000" }
      : r,
);

/** Bullish: top-2 float grew ~0.5% day-over-day. */
const STABLE_GROWING = {
  peggedAssets: [
    {
      id: "1",
      name: "Tether",
      symbol: "USDT",
      pegType: "peggedUSD",
      pegMechanism: "fiat-backed",
      price: 1.0,
      circulating: { peggedUSD: 110e9 },
      circulatingPrevDay: { peggedUSD: 109.5e9 },
      chainCirculating: { Ethereum: { current: { peggedUSD: 50e9 } } },
    },
    {
      id: "2",
      name: "USD Coin",
      symbol: "USDC",
      pegType: "peggedUSD",
      price: 1.0,
      circulating: { peggedUSD: 30e9 },
      circulatingPrevDay: { peggedUSD: 29.8e9 },
    },
  ],
};

const STABLE_SHRINKING = {
  peggedAssets: [
    {
      ...STABLE_GROWING.peggedAssets[0],
      circulatingPrevDay: { peggedUSD: 110.5e9 },
    },
    {
      ...STABLE_GROWING.peggedAssets[1],
      circulatingPrevDay: { peggedUSD: 30.2e9 },
    },
  ],
};

interface FetchOverrides {
  fng?: () => Response;
  trending?: () => Response;
  btc?: () => Response;
  coinbase?: () => Response;
  poly?: () => Response;
  funding?: () => Response;
  stable?: () => Response;
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Defaults = the BULLISH scenario: Greed 80, BTC +4%, funding +, float growing. */
function makeFetchStub(overrides: FetchOverrides = {}): typeof fetch {
  return (async (url: unknown) => {
    const u = String(url);
    if (u.includes("alternative.me")) {
      return overrides.fng ? overrides.fng() : ok(fng(80, "Greed"));
    }
    if (u.includes("search/trending")) {
      return overrides.trending ? overrides.trending() : ok(TRENDING_UPSTREAM);
    }
    if (u.includes("simple/price")) {
      return overrides.btc
        ? overrides.btc()
        : ok({ bitcoin: { usd: 62000, usd_24h_change: 4.0 } });
    }
    if (u.includes("coinbase.com")) {
      return overrides.coinbase
        ? overrides.coinbase()
        : ok({ data: { amount: "62100.50", base: "BTC", currency: "USD" } });
    }
    if (u.includes("smart-bias")) {
      return overrides.poly ? overrides.poly() : ok(POLY_UPSTREAM);
    }
    if (u.includes("premiumIndex")) {
      return overrides.funding ? overrides.funding() : ok(FUNDING_UPSTREAM);
    }
    if (u.includes("stablecoins.llama.fi")) {
      return overrides.stable ? overrides.stable() : ok(STABLE_GROWING);
    }
    throw new Error(`unexpected url in test: ${u}`);
  }) as typeof fetch;
}

/** DB stub keyed by `${chain}:${window}` — same trick as the pulse tests. */
function makeDbStub(
  rowsByKey: Partial<Record<string, Array<Record<string, unknown>>>>,
): DbQuerier {
  return {
    query: async (_sql: string, params?: unknown[]) => {
      const chain = String(params?.[0]);
      const windowStart = params?.[5] as Date;
      const hours = (Date.now() - windowStart.getTime()) / 3_600_000;
      const window = hours < 100 ? "24h" : "7d";
      return { rows: rowsByKey[`${chain}:${window}`] ?? [] };
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

/** 12 eligible solana tokens at ±100 → the pulse reads inflow/outflow. */
function netflowRows(
  sign: 1 | -1,
): Partial<Record<string, Array<Record<string, unknown>>>> {
  const solana24 = Array.from({ length: 12 }, (_, i) =>
    flowRow(`mintS${i}`, `TOK${i}`, sign * 100, 80),
  );
  const solana7d = Array.from({ length: 12 }, (_, i) =>
    flowRow(`mintS${i}`, `TOK${i}`, sign * 200, 80),
  );
  return {
    "solana:24h": solana24,
    "solana:7d": solana7d,
    "base:24h": [flowRow("mintB0", "BORK", sign * 50, 75)],
    "base:7d": [flowRow("mintB0", "BORK", sign * 80, 75)],
  };
}

interface RegimeBody {
  verdict: { regime: string; score: number; summary: string; confidence: number };
  signals: {
    drivers: Array<{
      name: string;
      direction: string;
      weight: number;
      value: unknown;
      evidence: string;
      score: number | null;
      fresh: boolean;
    }>;
    smart_money_confirmation: {
      direction: string | null;
      agrees_with_regime: boolean;
    };
    base_pulse: {
      regime_from_pulse: string | null;
      sentiment: { value: number | null; classification: string | null };
      btc: { price_usd: number | null; change_24h_pct: number | null };
    };
  };
  data_quality: {
    stale_sources: string[];
    computed_at: string;
    drivers_fresh_count: number;
  };
  raw: Record<string, unknown>;
}

function driver(body: RegimeBody, name: string) {
  const d = body.signals.drivers.find((x) => x.name === name);
  expect(d, `driver ${name} present`).toBeDefined();
  return d!;
}

// Baseline inputs for classifyRegime table tests: everything null.
const ALL_NULL = {
  fear_greed_value: null,
  btc_24h_pct: null,
  smart_money_direction: null,
  smart_money_magnitude: null,
  funding_btc: null,
  funding_eth: null,
  stablecoin_7d_delta_pct: null,
} as const;

// ─────────────────────────────────────────────────────────────────────
// classifyRegime — pure table tests
// ─────────────────────────────────────────────────────────────────────

describe("REGIME_WEIGHTS", () => {
  it("sum to exactly 1.0", () => {
    const sum = Object.values(REGIME_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });
});

describe("classifyRegime — table", () => {
  it("all drivers strongly bullish -> risk_on at full confidence", () => {
    const c = classifyRegime({
      fear_greed_value: 100,
      btc_24h_pct: 6,
      smart_money_direction: "inflow",
      smart_money_magnitude: 6000,
      funding_btc: 0.0006,
      funding_eth: 0.0006,
      stablecoin_7d_delta_pct: 2,
    });
    expect(c.regime).toBe("risk_on");
    expect(c.score).toBe(0.95); // 0.2+0.25+0.25+0.15+0.10, poly omitted
    expect(c.confidence).toBe(1);
    expect(c.drivers).toHaveLength(5);
    expect(c.drivers.every((d) => d.direction === "bullish")).toBe(true);
  });

  it("all drivers strongly bearish -> risk_off", () => {
    const c = classifyRegime({
      fear_greed_value: 0,
      btc_24h_pct: -6,
      smart_money_direction: "outflow",
      smart_money_magnitude: 6000,
      funding_btc: -0.0006,
      funding_eth: -0.0006,
      stablecoin_7d_delta_pct: -2,
    });
    expect(c.regime).toBe("risk_off");
    expect(c.score).toBe(-0.95);
    expect(c.drivers.every((d) => d.direction === "bearish")).toBe(true);
  });

  it("strong conflicting drivers -> chop with lowered confidence", () => {
    const bullish = classifyRegime({
      fear_greed_value: 90,
      btc_24h_pct: 6,
      smart_money_direction: "inflow",
      smart_money_magnitude: 6000,
      funding_btc: 0.0006,
      funding_eth: 0.0006,
      stablecoin_7d_delta_pct: 2,
    });
    const conflicted = classifyRegime({
      fear_greed_value: 100, // +0.20
      btc_24h_pct: -10, // -0.25
      smart_money_direction: "inflow",
      smart_money_magnitude: 5000, // +0.25
      funding_btc: -0.0005,
      funding_eth: -0.0005, // -0.15
      stablecoin_7d_delta_pct: 1, // +0.10
    });
    expect(conflicted.regime).toBe("chop"); // S = +0.15
    expect(conflicted.score).toBe(0.15);
    expect(conflicted.confidence).toBeLessThan(bullish.confidence);
    expect(conflicted.confidence).toBeLessThan(0.5);
  });

  it("boundary: S = +0.25 exactly is chop (strict >)", () => {
    const c = classifyRegime({
      ...ALL_NULL,
      smart_money_direction: "inflow",
      smart_money_magnitude: 5000, // score 1 × weight 0.25 = 0.25
    });
    expect(c.score).toBe(0.25);
    expect(c.regime).toBe("chop");
  });

  it("boundary: S = -0.25 exactly is chop (strict <)", () => {
    const c = classifyRegime({
      ...ALL_NULL,
      smart_money_direction: "outflow",
      smart_money_magnitude: 5000,
    });
    expect(c.score).toBe(-0.25);
    expect(c.regime).toBe("chop");
  });

  it("just above +0.25 tips to risk_on", () => {
    const c = classifyRegime({
      ...ALL_NULL,
      fear_greed_value: 51, // +0.004
      smart_money_direction: "inflow",
      smart_money_magnitude: 5000, // +0.25
    });
    expect(c.score).toBe(0.254);
    expect(c.regime).toBe("risk_on");
  });

  it("just below -0.25 tips to risk_off", () => {
    const c = classifyRegime({
      ...ALL_NULL,
      fear_greed_value: 49,
      smart_money_direction: "outflow",
      smart_money_magnitude: 5000,
    });
    expect(c.score).toBe(-0.254);
    expect(c.regime).toBe("risk_off");
  });

  it("stale drivers contribute zero and lower confidence via freshness", () => {
    const c = classifyRegime({
      ...ALL_NULL,
      fear_greed_value: 90, // only fresh driver: +0.20 -> chop
    });
    expect(c.regime).toBe("chop");
    expect(c.drivers.filter((d) => d.fresh)).toHaveLength(1);
    expect(driverByName(c.drivers, "funding").score).toBeNull();
    expect(driverByName(c.drivers, "funding").direction).toBe("neutral");
    expect(c.confidence).toBeLessThan(0.5);
  });

  it("stablecoin 7d delta takes precedence over the 24h fallback", () => {
    const c = classifyRegime({
      ...ALL_NULL,
      stablecoin_7d_delta_pct: 1.0,
      stablecoin_24h_delta_pct: -5,
    });
    const d = driverByName(c.drivers, "stablecoins");
    expect(d.value).toBe(1.0);
    expect(d.direction).toBe("bullish");
  });

  it("falls back to the 24h stablecoin window when 7d is null", () => {
    const c = classifyRegime({
      ...ALL_NULL,
      stablecoin_7d_delta_pct: null,
      stablecoin_24h_delta_pct: 0.3, // full scale on the 24h window
    });
    const d = driverByName(c.drivers, "stablecoins");
    expect(d.score).toBe(1);
    expect(d.fresh).toBe(true);
  });

  it("funding averages the available legs (one null leg ok)", () => {
    const c = classifyRegime({
      ...ALL_NULL,
      funding_btc: 0.0005,
      funding_eth: null,
    });
    expect(driverByName(c.drivers, "funding").score).toBe(1);
  });

  it("smart-money direction without magnitude scores half-strength", () => {
    const c = classifyRegime({
      ...ALL_NULL,
      smart_money_direction: "outflow",
      smart_money_magnitude: null,
    });
    expect(driverByName(c.drivers, "smart_money").score).toBe(-0.5);
  });

  it("polymarket driver only participates when the caller passes it", () => {
    const without = classifyRegime({ ...ALL_NULL, fear_greed_value: 50 });
    expect(without.drivers).toHaveLength(5);
    const withBias = classifyRegime({
      ...ALL_NULL,
      fear_greed_value: 50,
      polymarket_bias: 100,
    });
    expect(withBias.drivers).toHaveLength(6);
    expect(driverByName(withBias.drivers, "polymarket").score).toBe(1);
    expect(withBias.score).toBeCloseTo(0.05, 10);
  });

  function driverByName(
    drivers: Array<{ name: string; [k: string]: unknown }>,
    name: string,
  ) {
    const d = drivers.find((x) => x.name === name);
    expect(d, `driver ${name}`).toBeDefined();
    return d as {
      name: string;
      score: number | null;
      direction: string;
      value: unknown;
      fresh: boolean;
    };
  }
});

// ─────────────────────────────────────────────────────────────────────
// Validator + input schema
// ─────────────────────────────────────────────────────────────────────

describe("marketRegimeVerdictValidator", () => {
  it("accepts empty / missing bodies (the product)", () => {
    expect(marketRegimeVerdictValidator(null, "POST")).toBeNull();
    expect(marketRegimeVerdictValidator(Buffer.alloc(0), "POST")).toBeNull();
  });

  it("accepts non-JSON garbage as defaults (discovery-probe friendly)", () => {
    expect(marketRegimeVerdictValidator(Buffer.from("not json"), "POST")).toBeNull();
  });

  it("accepts {} and a valid detail", () => {
    expect(marketRegimeVerdictValidator(Buffer.from("{}"), "POST")).toBeNull();
    expect(
      marketRegimeVerdictValidator(Buffer.from('{"detail":"summary"}'), "POST"),
    ).toBeNull();
    expect(
      marketRegimeVerdictValidator(Buffer.from('{"detail":"full"}'), "POST"),
    ).toBeNull();
  });

  it("422s a bad detail value, with the machine-readable input_schema", () => {
    const res = marketRegimeVerdictValidator(
      Buffer.from('{"detail":"verbose"}'),
      "POST",
    );
    expect(res?.status).toBe(422);
    expect((res?.body as { error: string }).error).toBe("invalid_detail");
    expect((res?.body as { input_schema: unknown }).input_schema).toBe(
      marketRegimeVerdictInputSchema,
    );
  });

  it("422s a non-string detail", () => {
    const res = marketRegimeVerdictValidator(Buffer.from('{"detail":5}'), "POST");
    expect(res?.status).toBe(422);
  });

  it("422s a JSON array body", () => {
    const res = marketRegimeVerdictValidator(Buffer.from("[1,2]"), "POST");
    expect(res?.status).toBe(422);
    expect((res?.body as { error: string }).error).toBe("invalid_body");
  });

  it("schema declares the optional detail field only", () => {
    expect(marketRegimeVerdictInputSchema.body.required).toEqual([]);
    expect(
      Object.keys(marketRegimeVerdictInputSchema.body.properties),
    ).toEqual(["detail"]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Preflight — delegated fail-closed gate
// ─────────────────────────────────────────────────────────────────────

describe("marketRegimeVerdictPreflight", () => {
  it("proceeds with the pulse's critical data when healthy", async () => {
    const pf = await marketRegimeVerdictPreflight({
      body: null,
      method: "POST",
      fetchImpl: makeFetchStub(),
      db: makeDbStub(netflowRows(1)),
    });
    expect(pf.proceed).toBe(true);
    if (pf.proceed) expect(pf.data).toBeDefined();
  });

  it("refuses (503, buyer not charged) when the pulse preflight fails", async () => {
    const pf = await marketRegimeVerdictPreflight({
      body: null,
      method: "POST",
      fetchImpl: makeFetchStub({ fng: () => new Response("", { status: 500 }) }),
      db: makeDbStub(netflowRows(1)),
    });
    expect(pf.proceed).toBe(false);
    if (!pf.proceed) {
      expect(pf.status).toBe(503);
      expect((pf.body as { source: string }).source).toBe("fear_greed");
    }
  });

  it("refuses when no db is wired (misconfiguration fail-closed)", async () => {
    const pf = await marketRegimeVerdictPreflight({
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

describe("marketRegimeVerdict — regimes end to end", () => {
  it("bullish everywhere -> risk_on with agreeing smart money", async () => {
    const res = await marketRegimeVerdict({
      body: Buffer.from("{}"),
      method: "POST",
      fetchImpl: makeFetchStub(),
      db: makeDbStub(netflowRows(1)),
    });
    expect(res.status).toBe(200);
    const body = res.body as RegimeBody;

    // fng 0.12 + btc 0.2 + smart 0.06 + funding 0.12 + stable 0.10
    expect(body.verdict.regime).toBe("risk_on");
    expect(body.verdict.score).toBe(0.6);
    expect(body.verdict.confidence).toBe(1);
    expect(body.verdict.summary).toContain("Risk-on");
    expect(body.verdict.summary).toContain("btc_momentum");

    expect(body.signals.drivers).toHaveLength(5);
    expect(driver(body, "fear_greed").direction).toBe("bullish");
    expect(driver(body, "funding").value).toBeCloseTo(0.0004, 10);
    expect(driver(body, "stablecoins").fresh).toBe(true);

    expect(body.signals.smart_money_confirmation).toEqual({
      direction: "inflow",
      agrees_with_regime: true,
    });
    // The base pulse reads Greed + inflow as confirmed_rally.
    expect(body.signals.base_pulse.regime_from_pulse).toBe("confirmed_rally");
    expect(body.signals.base_pulse.sentiment.value).toBe(80);
    expect(body.signals.base_pulse.btc.price_usd).toBe(62000);

    expect(body.data_quality.stale_sources).toEqual([]);
    expect(body.data_quality.drivers_fresh_count).toBe(5);
    expect(body.data_quality.computed_at).toMatch(/^\d{4}-/);

    // Full detail: raw carries the base pulse verbatim + capped extras.
    expect(body.raw["pulse"]).toBeDefined();
    expect(body.raw["funding"]).toBeDefined();
    const rawStable = body.raw["stablecoins"] as { stablecoins: unknown[] };
    expect(rawStable.stablecoins.length).toBeLessThanOrEqual(10);
  });

  it("bearish everywhere -> risk_off", async () => {
    const res = await marketRegimeVerdict({
      body: null,
      method: "POST",
      fetchImpl: makeFetchStub({
        fng: () => ok(fng(15, "Extreme Fear")),
        btc: () => ok({ bitcoin: { usd: 58000, usd_24h_change: -4.0 } }),
        funding: () => ok(FUNDING_BEARISH),
        stable: () => ok(STABLE_SHRINKING),
      }),
      db: makeDbStub(netflowRows(-1)),
    });
    expect(res.status).toBe(200);
    const body = res.body as RegimeBody;
    expect(body.verdict.regime).toBe("risk_off");
    // fng -0.14 (15/100) + btc -0.2 + smart -0.06 + funding -0.12 + stable -0.10
    expect(body.verdict.score).toBe(-0.62);
    expect(body.signals.smart_money_confirmation).toEqual({
      direction: "outflow",
      agrees_with_regime: true,
    });
  });

  it("conflicting drivers -> chop with lowered confidence", async () => {
    // Greed + smart inflow vs falling BTC + shrinking float: S = 0.
    const res = await marketRegimeVerdict({
      body: null,
      method: "POST",
      fetchImpl: makeFetchStub({
        btc: () => ok({ bitcoin: { usd: 58000, usd_24h_change: -4.0 } }),
        stable: () => ok(STABLE_SHRINKING),
      }),
      db: makeDbStub(netflowRows(1)),
    });
    const body = res.body as RegimeBody;
    expect(body.verdict.regime).toBe("chop");
    expect(body.verdict.confidence).toBeLessThan(0.5); // dispersion penalty
    expect(body.signals.smart_money_confirmation.agrees_with_regime).toBe(false);
  });
});

describe("marketRegimeVerdict — driver degradation (paid call still served)", () => {
  it("funding upstream down -> 200, stale driver, lower confidence", async () => {
    const res = await marketRegimeVerdict({
      body: null,
      method: "POST",
      fetchImpl: makeFetchStub({
        funding: () => new Response("", { status: 500 }),
      }),
      db: makeDbStub(netflowRows(1)),
    });
    expect(res.status).toBe(200);
    const body = res.body as RegimeBody;
    expect(body.verdict.regime).toBe("risk_on"); // S = 0.48 without funding
    expect(driver(body, "funding").fresh).toBe(false);
    expect(driver(body, "funding").score).toBeNull();
    expect(body.data_quality.stale_sources).toContain("funding");
    expect(body.data_quality.drivers_fresh_count).toBe(4);
    expect(body.verdict.confidence).toBeLessThan(1);
    expect(body.raw["funding"]).toBeNull();
  });

  it("stablecoin upstream down -> 200, stale driver, lower confidence", async () => {
    const res = await marketRegimeVerdict({
      body: null,
      method: "POST",
      fetchImpl: makeFetchStub({
        stable: () => new Response("", { status: 500 }),
      }),
      db: makeDbStub(netflowRows(1)),
    });
    expect(res.status).toBe(200);
    const body = res.body as RegimeBody;
    expect(driver(body, "stablecoins").fresh).toBe(false);
    expect(body.data_quality.stale_sources).toContain("stablecoins");
    expect(body.data_quality.drivers_fresh_count).toBe(4);
    expect(body.verdict.confidence).toBeLessThan(1);
    expect(body.raw["stablecoins"]).toBeNull();
  });

  it("pulse's own stale sources are merged into ours", async () => {
    const res = await marketRegimeVerdict({
      body: null,
      method: "POST",
      fetchImpl: makeFetchStub({
        trending: () => new Response("", { status: 500 }),
        funding: () => new Response("", { status: 500 }),
      }),
      db: makeDbStub(netflowRows(1)),
    });
    const body = (res.body as RegimeBody).data_quality.stale_sources;
    expect(body).toContain("trending"); // from the pulse
    expect(body).toContain("funding"); // ours
  });
});

describe("marketRegimeVerdict — input handling", () => {
  it("empty body is the product", async () => {
    const res = await marketRegimeVerdict({
      body: null,
      method: "POST",
      fetchImpl: makeFetchStub(),
      db: makeDbStub(netflowRows(1)),
    });
    expect(res.status).toBe(200);
    expect((res.body as RegimeBody).verdict.regime).toBe("risk_on");
  });

  it("non-JSON body collapses to defaults, never 400s the base pulse", async () => {
    const res = await marketRegimeVerdict({
      body: Buffer.from("plain text probe"),
      method: "POST",
      fetchImpl: makeFetchStub(),
      db: makeDbStub(netflowRows(1)),
    });
    expect(res.status).toBe(200);
    expect((res.body as RegimeBody).raw["pulse"]).toBeDefined(); // full default
  });

  it("detail=summary omits raw.pulse but keeps the driver raws", async () => {
    const res = await marketRegimeVerdict({
      body: Buffer.from('{"detail":"summary"}'),
      method: "POST",
      fetchImpl: makeFetchStub(),
      db: makeDbStub(netflowRows(1)),
    });
    expect(res.status).toBe(200);
    const body = res.body as RegimeBody;
    expect("pulse" in body.raw).toBe(false);
    expect(body.raw["funding"]).toBeDefined();
    expect(body.raw["stablecoins"]).toBeDefined();
    expect(body.verdict.regime).toBe("risk_on"); // verdict unaffected
  });

  it("bad detail -> 422 through the handler path too", async () => {
    const res = await marketRegimeVerdict({
      body: Buffer.from('{"detail":"raw"}'),
      method: "POST",
      fetchImpl: makeFetchStub(),
      db: makeDbStub(netflowRows(1)),
    });
    expect(res.status).toBe(422);
    expect((res.body as { input_schema: unknown }).input_schema).toBeDefined();
  });
});

describe("marketRegimeVerdict — critical base failure (direct invocation)", () => {
  it("503s when the pulse cannot be computed and no preflight data exists", async () => {
    const res = await marketRegimeVerdict({
      body: null,
      method: "POST",
      fetchImpl: makeFetchStub({ fng: () => new Response("", { status: 500 }) }),
      db: makeDbStub(netflowRows(1)),
    });
    expect(res.status).toBe(503);
    const body = res.body as { error: string; source: string; retryable: boolean };
    expect(body.error).toBe("critical_source_unavailable");
    expect(body.source).toBe("crypto_market_pulse");
    expect(body.retryable).toBe(true);
  });
});

describe("marketRegimeVerdict — preflightData passthrough", () => {
  it("critical pulse sources are not recomputed after the preflight", async () => {
    let dbCalls = 0;
    let fngCalls = 0;
    const countingDb: DbQuerier = {
      query: async (...args: [string, unknown[]?]) => {
        dbCalls += 1;
        return makeDbStub(netflowRows(1)).query(...args);
      },
    };
    const inner = makeFetchStub();
    const countingFetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes("alternative.me")) fngCalls += 1;
      return (inner as (u: unknown, i?: unknown) => Promise<Response>)(url, init);
    }) as typeof fetch;

    const pf = await marketRegimeVerdictPreflight({
      body: null,
      method: "POST",
      fetchImpl: countingFetch,
      db: countingDb,
    });
    expect(pf.proceed).toBe(true);
    const dbAfterPreflight = dbCalls; // 2 chains × 2 windows
    const fngAfterPreflight = fngCalls;
    expect(dbAfterPreflight).toBeGreaterThan(0);
    expect(fngAfterPreflight).toBe(1);

    const res = await marketRegimeVerdict({
      body: null,
      method: "POST",
      fetchImpl: countingFetch,
      db: countingDb,
      preflightData: pf.proceed ? pf.data : undefined,
    });
    expect(res.status).toBe(200);
    expect((res.body as RegimeBody).verdict.regime).toBe("risk_on");
    // Neither the netflow query nor fear-greed ran a second time.
    expect(dbCalls).toBe(dbAfterPreflight);
    expect(fngCalls).toBe(fngAfterPreflight);
  });
});

// ─────────────────────────────────────────────────────────────────────
// buildRegimeResponse — pure assembly
// ─────────────────────────────────────────────────────────────────────

describe("buildRegimeResponse", () => {
  const pulseBody = {
    verdict: { regime: "confirmed_rally", summary: "s", confidence: "high" },
    signals: {
      sentiment: { value: 80, classification: "Greed", bucket: "greed" },
      smart_money: {
        solana: { direction: "inflow", sum_net_flow_usd_24h: 1200 },
        base: { direction: "outflow", sum_net_flow_usd_24h: -50 },
      },
      btc: { price_usd: 62000, change_24h_pct: 4, source: "coingecko" },
      trending: [],
      polymarket: [],
    },
    data_quality: { stale_sources: ["polymarket"], computed_at: "x" },
    raw: {},
  };
  const funding = {
    ok: true,
    error: null,
    funding_btc: 0.0004,
    funding_eth: 0.0004,
    raw: { rates: [] },
  };
  const stable = {
    ok: true,
    error: null,
    total_supply_usd: 140e9,
    delta_24h_usd: 7e8,
    delta_24h_pct: 0.5,
    delta_7d_pct: null as null,
    raw: { stablecoins: [] },
  };

  it("uses the production chain (solana) for smart-money confirmation", () => {
    const out = buildRegimeResponse({
      pulseBody,
      funding,
      stable,
      detail: "full",
      computedAt: new Date("2026-07-01T00:00:00Z"),
    }) as unknown as RegimeBody;
    expect(out.signals.smart_money_confirmation.direction).toBe("inflow");
    expect(out.verdict.regime).toBe("risk_on");
    expect(out.data_quality.stale_sources).toEqual(["polymarket"]);
    expect(out.data_quality.computed_at).toBe("2026-07-01T00:00:00.000Z");
    expect(out.signals.base_pulse.regime_from_pulse).toBe("confirmed_rally");
  });

  it("degrades gracefully when the pulse's btc leg was null", () => {
    const noBtc = {
      ...pulseBody,
      signals: { ...pulseBody.signals, btc: null },
    };
    const out = buildRegimeResponse({
      pulseBody: noBtc,
      funding,
      stable,
      detail: "summary",
      computedAt: new Date(),
    }) as unknown as RegimeBody;
    const btcDriver = out.signals.drivers.find((d) => d.name === "btc_momentum");
    expect(btcDriver?.fresh).toBe(false);
    expect("pulse" in out.raw).toBe(false);
  });
});
