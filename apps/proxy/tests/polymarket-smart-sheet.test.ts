import { describe, expect, it } from "vitest";
import {
  buildSmartSheetResponse,
  parseSheetBody,
  polymarketSmartSheet,
  polymarketSmartSheetPreflight,
  polymarketSmartSheetValidator,
  rankMarkets,
  type BuildSheetArgs,
  type SkillResponse,
  type SourceResult,
  type WhaleResponse,
} from "../src/handlers/polymarket-smart-sheet.js";

// ─────────────────────────────────────────────────────────────────────
// Upstream fixtures — shapes mirror polymarket-smart-money routes.
// ─────────────────────────────────────────────────────────────────────

function biasItem(
  id: string,
  title: string,
  category: string,
  bias: number,
  conviction: number,
): Record<string, unknown> {
  return {
    market_id: id,
    market_title: title,
    category,
    current_yes_price: 0.42,
    current_no_price: 0.58,
    smart_yes_volume_usd: bias >= 0 ? 1000 : 100,
    smart_no_volume_usd: bias >= 0 ? 100 : 1000,
    smart_yes_traders: 3,
    smart_no_traders: 2,
    smart_avg_skill_score: 71.3,
    bias_score: bias,
    conviction_score: conviction,
    trade_count_smart: 9,
  };
}

const BIAS_META = {
  eligibility_filter_mode: "skill_score_gte_60",
  smart_traders_tracked: 180,
  active_markets_count: 320,
  markets_with_signal: 41,
  coverage_level: "beta",
  score_version: "polymarket-v1",
  score_calibration_version: "brier-v1-day7",
  warnings: ["easy_market_specialist_tightening_pending"],
  metric_reliability: {
    smart_money_volume: "verified",
    bias_score: "calculated",
    conviction_score: "calculated",
    trader_skill: "brier_normalized_v1",
  },
  calculated_at: "2026-07-01T12:00:00.000Z",
};

// Deliberately NOT in |bias| order — ranking is the handler's job.
// Ranked by |bias|: mA(95) mB(80) mC(60) mD(40) mE(30) mF(10) mG(0).
// Top-5 categories are all distinct -> exactly 5 position-holders calls.
const BIAS_UPSTREAM = {
  data: [
    biasItem("mB", "Will BTC close above $150k in 2026?", "crypto", 80, 70),
    biasItem("mA", "Will the incumbent win the runoff?", "politics", -95, 50),
    biasItem("mD", "Will Team X win the finals?", "sports", -40, 65),
    biasItem("mC", "Will the treaty be ratified?", "other", 60, 20),
    biasItem("mE", "Will CPI print above 4%?", "macro", 30, 30),
    biasItem("mF", "Will SOL hit $500?", "crypto", 10, 10),
    biasItem("mG", "Zero-edge market", "other", 0, 5),
  ],
  meta: BIAS_META,
};

function whaleItem(
  marketId: string,
  hash: string,
  side: "YES" | "NO",
  sizeUsd: number,
): Record<string, unknown> {
  return {
    market_id: marketId,
    market_title: "t",
    category: "crypto",
    trader_address_hash: hash,
    trader_skill_score: 74.2,
    trader_skill_tier: "skilled",
    side,
    size_usd: sizeUsd,
    entry_price: 0.41,
    current_market_price: 0.45,
    market_price_change_since_entry: 0.04,
    trade_count_smart: 2,
    tx_hash: "0xdeadbeef",
    timestamp: "2026-07-01T11:30:00.000Z",
  };
}

const WHALE_UPSTREAM = {
  data: [
    whaleItem("mA", "a1b2c3d4e5f6g7h8i9", "YES", 6_000),
    whaleItem("mA", "b2c3d4e5f6g7h8i9j0", "NO", 9_000),
    whaleItem("mB", "c3d4e5f6g7h8i9j0k1", "YES", 12_000),
  ],
  meta: {
    eligibility_filter_mode: "skill_score_gte_60",
    smart_traders_tracked: 180,
    entries_count_total_in_window: 3,
    entries_returned: 3,
    coverage_level: "beta",
    score_version: "polymarket-v1",
    warnings: [],
  },
};

const SKILL_UPSTREAM = {
  data: [
    {
      trader_address_hash: "c3d4e5f6g7h8i9j0k1",
      rank: 1,
      overall_skill_score: 91.2,
      confidence_score: 88,
      tier: "elite",
      resolved_markets_count: 44,
      win_rate: 0.7,
    },
    {
      trader_address_hash: "b2c3d4e5f6g7h8i9j0",
      rank: 4,
      overall_skill_score: 72,
      confidence_score: 70,
      tier: "skilled",
      resolved_markets_count: 30,
      win_rate: 0.61,
    },
  ],
  meta: { total_active_traders: 180, coverage_level: "beta" },
};

function holdersItem(marketId: string): Record<string, unknown> {
  return {
    market_id: marketId,
    market_title: "t",
    category: "politics",
    current_yes_price: 0.2,
    current_no_price: 0.8,
    side_dominant: "NO",
    skilled_holders_count_yes: 2,
    skilled_holders_count_no: 6,
    total_value_usd_yes: 10_000,
    total_value_usd_no: 40_000,
    total_value_usd_combined: 50_000,
    yes_position_concentration: 0.2,
    largest_position_usd: 20_000,
    largest_holder_skill: 84.1,
    largest_holder_tier: "elite",
    avg_skill_score: 71.5,
    avg_entry_price_yes: 0.25,
    avg_entry_price_no: 0.7,
    conviction_score: 77,
    total_unrealized_pnl_usd: 3_200,
  };
}

// mF is rank 6 — even though the upstream returns it, the top-5 cap
// must keep it out of the sheet's holder_concentration column.
const HOLDERS_UPSTREAM = {
  data: [holdersItem("mA"), holdersItem("mB"), holdersItem("mF")],
  meta: { coverage_level: "beta", markets_returned: 3, warnings: [] },
};

// ─────────────────────────────────────────────────────────────────────
// Fetch stub — keyed by URL substring, records calls + request bodies.
// ─────────────────────────────────────────────────────────────────────

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface StubOverrides {
  bias?: () => Response;
  whale?: () => Response;
  skill?: () => Response;
  holders?: () => Response;
}

function makeStub(overrides: StubOverrides = {}) {
  const calls = { bias: 0, whale: 0, skill: 0, holders: 0 };
  const bodies = {
    bias: [] as Array<Record<string, unknown>>,
    whale: [] as Array<Record<string, unknown>>,
    skill: [] as Array<Record<string, unknown>>,
    holders: [] as Array<Record<string, unknown>>,
  };
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    if (u.includes("/v1/polymarket/smart-bias")) {
      calls.bias += 1;
      bodies.bias.push(body);
      return overrides.bias ? overrides.bias() : ok(BIAS_UPSTREAM);
    }
    if (u.includes("/v1/polymarket/whale-entries")) {
      calls.whale += 1;
      bodies.whale.push(body);
      return overrides.whale ? overrides.whale() : ok(WHALE_UPSTREAM);
    }
    if (u.includes("/v1/polymarket/trader-skill")) {
      calls.skill += 1;
      bodies.skill.push(body);
      return overrides.skill ? overrides.skill() : ok(SKILL_UPSTREAM);
    }
    if (u.includes("/v1/polymarket/position-holders")) {
      calls.holders += 1;
      bodies.holders.push(body);
      return overrides.holders ? overrides.holders() : ok(HOLDERS_UPSTREAM);
    }
    throw new Error(`unexpected url in test: ${u}`);
  }) as typeof fetch;
  return { fetchImpl, calls, bodies };
}

const neverFetch = (async () => {
  throw new Error("fetch must not be called");
}) as typeof fetch;

interface SheetRow {
  rank: number;
  market_id: string;
  title: string | null;
  category: string | null;
  bias_score: number;
  direction: string;
  confidence: string;
  conviction_score: number;
  whale_entries: {
    window: string;
    count: number;
    net_usd: number;
    dominant_side: string;
  } | null;
  skill_positioning: {
    ranked_entrants: number;
    avg_entrant_skill: number | null;
    best_entrant_rank: number | null;
    best_entrant_tier: string | null;
  } | null;
  holder_concentration: Record<string, unknown> | null;
  freshness: { bias_computed_at: string | null };
}

interface SheetBody {
  verdict: {
    markets_with_edge: number;
    top_pick: {
      market_id: string;
      direction: string;
      bias_score: number;
      confidence: string;
    } | null;
    summary: string;
    confidence: string;
  };
  sheet: SheetRow[];
  signals: {
    sources_used: string[];
    whale_totals: Record<string, unknown> | null;
    skill_coverage: Record<string, unknown> | null;
  };
  data_quality: {
    stale_sources: string[];
    computed_at: string;
    sheet_rows: number;
    sources: Record<string, string>;
  };
  raw: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────
// parseSheetBody — the loyal-buyer contract
// ─────────────────────────────────────────────────────────────────────

describe("parseSheetBody", () => {
  it("empty / null / whitespace bodies -> defaults", () => {
    for (const b of [null, Buffer.alloc(0), Buffer.from("   ")]) {
      const p = parseSheetBody(b);
      expect(p.kind).toBe("ok");
      if (p.kind === "ok") {
        expect(p.opts).toEqual({ limit: 20, category: "all", timeWindow: "24h" });
      }
    }
  });

  it("the loyal buyer's fossilized swap body -> defaults, never an error", () => {
    const p = parseSheetBody(
      Buffer.from(
        JSON.stringify({
          input_token: "So11111111111111111111111111111111111111112",
          slippage_bps: 100,
        }),
      ),
    );
    expect(p.kind).toBe("ok");
    if (p.kind === "ok") expect(p.opts.limit).toBe(20);
  });

  it("non-JSON, arrays, and scalars -> defaults", () => {
    for (const b of ["{nope", "[1,2,3]", '"hello"', "42", "null"]) {
      expect(parseSheetBody(Buffer.from(b)).kind).toBe("ok");
    }
  });

  it("clamps limit into 1..50 instead of rejecting", () => {
    const cases: Array<[number, number]> = [
      [500, 50],
      [0, 1],
      [-3, 1],
      [20.7, 20],
      [1, 1],
      [50, 50],
    ];
    for (const [input, expected] of cases) {
      const p = parseSheetBody(Buffer.from(JSON.stringify({ limit: input })));
      expect(p.kind).toBe("ok");
      if (p.kind === "ok") expect(p.opts.limit).toBe(expected);
    }
  });

  it("accepts valid category + time_window (case/space tolerant)", () => {
    const p = parseSheetBody(
      Buffer.from(JSON.stringify({ limit: 5, category: " Crypto ", time_window: "7d" })),
    );
    expect(p.kind).toBe("ok");
    if (p.kind === "ok") {
      expect(p.opts).toEqual({ limit: 5, category: "crypto", timeWindow: "7d" });
    }
  });

  it("placeholder strings from schema-blind probes are ignored", () => {
    const p = parseSheetBody(
      Buffer.from(
        JSON.stringify({ category: "<category>", time_window: "{window}", limit: "..." }),
      ),
    );
    expect(p.kind).toBe("ok");
    if (p.kind === "ok") {
      expect(p.opts).toEqual({ limit: 20, category: "all", timeWindow: "24h" });
    }
  });

  it("present-but-wrong-typed known fields -> invalid_field", () => {
    expect(parseSheetBody(Buffer.from('{"limit":true}')).kind).toBe("invalid_field");
    expect(parseSheetBody(Buffer.from('{"category":123}')).kind).toBe("invalid_field");
    expect(parseSheetBody(Buffer.from('{"time_window":"yesterday"}')).kind).toBe(
      "invalid_field",
    );
    expect(parseSheetBody(Buffer.from('{"category":"weather"}')).kind).toBe(
      "invalid_field",
    );
  });
});

describe("polymarketSmartSheetValidator", () => {
  it("garbage object bodies pass (default sheet, not an error)", () => {
    expect(
      polymarketSmartSheetValidator(Buffer.from('{"foo":"bar"}'), "POST"),
    ).toBeNull();
    expect(polymarketSmartSheetValidator(null, "POST")).toBeNull();
  });

  it("wrong-typed known field -> 422 carrying input_schema", () => {
    const res = polymarketSmartSheetValidator(Buffer.from('{"limit":true}'), "POST");
    expect(res?.status).toBe(422);
    const body = res?.body as { error: string; input_schema: unknown };
    expect(body.error).toBe("invalid_limit");
    expect(body.input_schema).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// rankMarkets
// ─────────────────────────────────────────────────────────────────────

describe("rankMarkets", () => {
  it("sorts by |bias| desc with conviction tie-break, drops id-less rows", () => {
    const ranked = rankMarkets([
      { market_id: "low", bias_score: 10, conviction_score: 99 },
      { market_id: "", bias_score: 100, conviction_score: 100 },
      { market_id: "tieA", bias_score: -50, conviction_score: 20 },
      { market_id: "tieB", bias_score: 50, conviction_score: 80 },
      { market_id: "high", bias_score: -90, conviction_score: 1 },
    ]);
    expect(ranked.map((m) => m.market_id)).toEqual(["high", "tieB", "tieA", "low"]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// buildSmartSheetResponse — pure assembly
// ─────────────────────────────────────────────────────────────────────

function criticalOf(
  data: Array<Record<string, unknown>>,
  meta: Record<string, unknown> = BIAS_META,
): BuildSheetArgs["critical"] {
  return {
    kind: "polymarket_smart_sheet_critical",
    category: "all",
    timeWindow: "24h",
    bias: { data, meta },
  };
}

const whaleOk: SourceResult<WhaleResponse> = {
  ok: true,
  data: { data: WHALE_UPSTREAM.data, meta: WHALE_UPSTREAM.meta },
};
const skillOk: SourceResult<SkillResponse> = {
  ok: true,
  data: { data: SKILL_UPSTREAM.data },
};
const fail = { ok: false as const, error: "status_503" };
const noHolders = { byMarket: {}, attempted: 0, failed: 0 };

describe("buildSmartSheetResponse", () => {
  it("emits all four layers plus capped raw", () => {
    const body = buildSmartSheetResponse({
      critical: criticalOf(BIAS_UPSTREAM.data),
      whale: whaleOk,
      skill: skillOk,
      holders: { byMarket: { mA: holdersItem("mA") }, attempted: 5, failed: 0 },
      limit: 20,
      computedAt: new Date("2026-07-01T13:00:00Z"),
    }) as unknown as SheetBody;
    expect(Object.keys(body).sort()).toEqual([
      "data_quality",
      "raw",
      "sheet",
      "signals",
      "verdict",
    ]);
    expect(body.verdict.markets_with_edge).toBe(6);
    expect(body.verdict.top_pick?.market_id).toBe("mA");
    expect(body.verdict.top_pick?.direction).toBe("no");
    expect(body.verdict.confidence).toBe("high");
    expect(body.sheet).toHaveLength(7);
    expect(body.data_quality.computed_at).toBe("2026-07-01T13:00:00.000Z");
    expect(body.data_quality.sheet_rows).toBe(7);
  });

  it("zero-edge sheet -> top_pick null and a no-edge summary", () => {
    const body = buildSmartSheetResponse({
      critical: criticalOf([
        biasItem("z1", "Flat one", "crypto", 0, 40),
        biasItem("z2", "Flat two", "macro", 0, 20),
      ]),
      whale: fail,
      skill: fail,
      holders: noHolders,
      limit: 20,
      computedAt: new Date(),
    }) as unknown as SheetBody;
    expect(body.verdict.markets_with_edge).toBe(0);
    expect(body.verdict.top_pick).toBeNull();
    expect(body.verdict.summary).toContain("No active Polymarket market");
    expect(body.sheet).toHaveLength(2); // rows still served
  });

  it("empty bias data -> empty sheet, null top_pick", () => {
    const body = buildSmartSheetResponse({
      critical: criticalOf([]),
      whale: whaleOk,
      skill: skillOk,
      holders: noHolders,
      limit: 20,
      computedAt: new Date(),
    }) as unknown as SheetBody;
    expect(body.sheet).toEqual([]);
    expect(body.verdict.top_pick).toBeNull();
    expect(body.data_quality.sources["position_holders"]).toBe("skipped");
  });

  it("limit truncates the sheet but not markets_with_edge", () => {
    const body = buildSmartSheetResponse({
      critical: criticalOf(BIAS_UPSTREAM.data),
      whale: whaleOk,
      skill: skillOk,
      holders: noHolders,
      limit: 2,
      computedAt: new Date(),
    }) as unknown as SheetBody;
    expect(body.sheet.map((r) => r.market_id)).toEqual(["mA", "mB"]);
    expect(body.sheet.map((r) => r.rank)).toEqual([1, 2]);
    expect(body.verdict.markets_with_edge).toBe(6);
  });

  it("degraded sources knock verdict confidence down a notch each", () => {
    const args = (
      whale: BuildSheetArgs["whale"],
      skill: BuildSheetArgs["skill"],
      meta: Record<string, unknown>,
    ): BuildSheetArgs => ({
      critical: criticalOf(BIAS_UPSTREAM.data, meta),
      whale,
      skill,
      holders: noHolders,
      limit: 20,
      computedAt: new Date(),
    });
    const high = buildSmartSheetResponse(args(whaleOk, skillOk, BIAS_META)) as unknown as SheetBody;
    expect(high.verdict.confidence).toBe("high");
    const medium = buildSmartSheetResponse(args(fail, skillOk, BIAS_META)) as unknown as SheetBody;
    expect(medium.verdict.confidence).toBe("medium");
    expect(medium.verdict.summary).toContain("whale_entries");
    const low = buildSmartSheetResponse(args(fail, fail, BIAS_META)) as unknown as SheetBody;
    expect(low.verdict.confidence).toBe("low");
    const nonBeta = buildSmartSheetResponse(
      args(whaleOk, skillOk, { ...BIAS_META, coverage_level: "experimental" }),
    ) as unknown as SheetBody;
    expect(nonBeta.verdict.confidence).toBe("medium");
  });

  it("caps oversized raw meta objects instead of dumping them", () => {
    const hugeMeta = { ...BIAS_META, blob: "x".repeat(5_000) };
    const body = buildSmartSheetResponse({
      critical: criticalOf(BIAS_UPSTREAM.data, hugeMeta),
      whale: whaleOk,
      skill: skillOk,
      holders: noHolders,
      limit: 20,
      computedAt: new Date(),
    }) as unknown as SheetBody;
    const capped = body.raw["smart_bias_meta"] as { truncated: boolean; bytes: number };
    expect(capped.truncated).toBe(true);
    expect(capped.bytes).toBeGreaterThan(4_000);
    expect(JSON.stringify(body.raw).length).toBeLessThan(4_200);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Preflight — fail-closed gate on smart-bias
// ─────────────────────────────────────────────────────────────────────

describe("polymarketSmartSheetPreflight", () => {
  it("proceeds with threaded bias data when smart-bias is healthy", async () => {
    const stub = makeStub();
    const pf = await polymarketSmartSheetPreflight({
      body: null,
      method: "POST",
      fetchImpl: stub.fetchImpl,
    });
    expect(pf.proceed).toBe(true);
    if (pf.proceed) expect(pf.data).toBeDefined();
    // ONLY the critical source is proven pre-settle.
    expect(stub.calls).toEqual({ bias: 1, whale: 0, skill: 0, holders: 0 });
    expect(stub.bodies.bias[0]).toEqual({
      category: "all",
      time_window: "24h",
      limit: 100,
    });
  });

  it("refuses (503, no charge) when smart-bias is down", async () => {
    const stub = makeStub({ bias: () => new Response("", { status: 503 }) });
    const pf = await polymarketSmartSheetPreflight({
      body: null,
      method: "POST",
      fetchImpl: stub.fetchImpl,
    });
    expect(pf.proceed).toBe(false);
    if (!pf.proceed) {
      expect(pf.status).toBe(503);
      expect((pf.body as { source: string }).source).toBe("smart_bias");
      expect((pf.body as { retryable: boolean }).retryable).toBe(true);
    }
  });

  it("refuses when smart-bias returns a mis-shaped payload", async () => {
    const stub = makeStub({ bias: () => ok({ data: "nope" }) });
    const pf = await polymarketSmartSheetPreflight({
      body: null,
      method: "POST",
      fetchImpl: stub.fetchImpl,
    });
    expect(pf.proceed).toBe(false);
    if (!pf.proceed) expect(pf.status).toBe(503);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Full handler
// ─────────────────────────────────────────────────────────────────────

describe("polymarketSmartSheet — happy path", () => {
  it("returns the ranked four-layer sheet with all sources joined", async () => {
    const stub = makeStub();
    const res = await polymarketSmartSheet({
      body: Buffer.from("{}"),
      method: "POST",
      fetchImpl: stub.fetchImpl,
    });
    expect(res.status).toBe(200);
    const body = res.body as SheetBody;

    // Ranked spine by |bias| desc.
    expect(body.sheet.map((r) => r.market_id)).toEqual([
      "mA",
      "mB",
      "mC",
      "mD",
      "mE",
      "mF",
      "mG",
    ]);
    expect(body.sheet.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // Row 1: mA — direction from sign, confidence from conviction.
    const rowA = body.sheet[0]!;
    expect(rowA.direction).toBe("no");
    expect(rowA.confidence).toBe("medium"); // conviction 50
    expect(rowA.whale_entries).toEqual({
      window: "24h",
      count: 2,
      net_usd: -3000,
      dominant_side: "NO",
    });
    expect(rowA.freshness.bias_computed_at).toBe("2026-07-01T12:00:00.000Z");
    // mA skill join: only hash b2c3… is ranked (rank 4, skilled).
    expect(rowA.skill_positioning).toEqual({
      ranked_entrants: 1,
      avg_entrant_skill: 72,
      best_entrant_rank: 4,
      best_entrant_tier: "skilled",
    });
    // mA holder concentration mapped from the position-holders row.
    expect(rowA.holder_concentration).toEqual({
      skilled_holders_yes: 2,
      skilled_holders_no: 6,
      yes_concentration: 0.2,
      side_dominant: "NO",
      total_value_usd: 50_000,
      largest_position_usd: 20_000,
      holders_conviction_score: 77,
    });

    // Row 2: mB — elite whale entrant joined through the hash.
    const rowB = body.sheet[1]!;
    expect(rowB.whale_entries).toEqual({
      window: "24h",
      count: 1,
      net_usd: 12_000,
      dominant_side: "YES",
    });
    expect(rowB.skill_positioning?.best_entrant_tier).toBe("elite");
    expect(rowB.skill_positioning?.avg_entrant_skill).toBe(91.2);
    expect(rowB.holder_concentration).not.toBeNull();

    // No whale tape on mC..mG -> null enrichment, never fabricated.
    expect(body.sheet[2]!.whale_entries).toBeNull();
    expect(body.sheet[2]!.skill_positioning).toBeNull();

    // Verdict.
    expect(body.verdict.markets_with_edge).toBe(6);
    expect(body.verdict.top_pick).toMatchObject({
      market_id: "mA",
      direction: "no",
      bias_score: -95,
    });
    expect(body.verdict.confidence).toBe("high");
    expect(body.verdict.summary).toContain("6 active Polymarket markets");
    expect(body.verdict.summary).toContain("leaning NO");

    // Signals.
    expect(body.signals.sources_used).toEqual([
      "smart_bias",
      "whale_entries",
      "trader_skill",
      "position_holders",
    ]);
    expect(body.signals.whale_totals).toEqual({
      window: "24h",
      entries: 3,
      yes_usd: 18_000,
      no_usd: 9_000,
      net_usd: 9_000,
    });
    expect(body.signals.skill_coverage).toEqual({
      ranked_traders: 2,
      entrants_matched: 2,
    });

    // Data quality.
    expect(body.data_quality.stale_sources).toEqual([]);
    expect(body.data_quality.sources).toEqual({
      smart_bias: "fresh",
      whale_entries: "fresh",
      trader_skill: "fresh",
      position_holders: "fresh",
    });

    // Raw layer bounded.
    expect(body.raw["smart_bias_meta"]).toBeDefined();
    expect(JSON.stringify(body.raw).length).toBeLessThanOrEqual(4_200);

    // Upstream request bodies match the routes' zod schemas.
    expect(stub.bodies.whale[0]).toEqual({
      time_window: "24h",
      category: "all",
      limit: 100,
    });
    expect(stub.bodies.skill[0]).toEqual({ category: "overall", limit: 100 });
    expect(stub.bodies.holders[0]).toMatchObject({
      min_skilled_holders: 1,
      min_total_position_usd: 100,
      limit: 100,
    });
  });

  it("position-holders: called once per top-5 category, hard cap 5, rank-6 market never joined", async () => {
    const stub = makeStub();
    const res = await polymarketSmartSheet({
      body: null,
      method: "POST",
      fetchImpl: stub.fetchImpl,
    });
    const body = res.body as SheetBody;
    // Top-5 categories are politics/crypto/other/sports/macro -> 5 calls.
    expect(stub.calls.holders).toBe(5);
    expect(stub.calls.holders).toBeLessThanOrEqual(5);
    const cats = stub.bodies.holders.map((b) => b["category"]).sort();
    expect(cats).toEqual(["crypto", "macro", "other", "politics", "sports"]);
    // mF (rank 6) appears in the upstream payload but is capped out.
    const rowF = body.sheet.find((r) => r.market_id === "mF")!;
    expect(rowF.holder_concentration).toBeNull();
    // Top-5 rows without an upstream match are null, not fabricated.
    const rowC = body.sheet.find((r) => r.market_id === "mC")!;
    expect(rowC.holder_concentration).toBeNull();
  });

  it("dedupes position-holders calls when top-5 categories repeat", async () => {
    const allCrypto = {
      data: ["c1", "c2", "c3", "c4", "c5", "c6"].map((id, i) =>
        biasItem(id, `Market ${id}`, "crypto", 90 - i * 10, 50),
      ),
      meta: BIAS_META,
    };
    const stub = makeStub({ bias: () => ok(allCrypto) });
    const res = await polymarketSmartSheet({
      body: null,
      method: "POST",
      fetchImpl: stub.fetchImpl,
    });
    expect(res.status).toBe(200);
    expect(stub.calls.holders).toBe(1);
  });

  it("maps a 1h sheet window to the whale route's 1h window and labels rows honestly", async () => {
    const stub = makeStub();
    const res = await polymarketSmartSheet({
      body: Buffer.from('{"time_window":"1h"}'),
      method: "POST",
      fetchImpl: stub.fetchImpl,
    });
    const body = res.body as SheetBody;
    expect(stub.bodies.whale[0]!["time_window"]).toBe("1h");
    expect(body.sheet[0]!.whale_entries?.window).toBe("1h");
    expect(body.signals.whale_totals?.["window"]).toBe("1h");
  });

  it("7d sheet window maps whale to 24h (widest the route supports)", async () => {
    const stub = makeStub();
    await polymarketSmartSheet({
      body: Buffer.from('{"time_window":"7d"}'),
      method: "POST",
      fetchImpl: stub.fetchImpl,
    });
    expect(stub.bodies.bias[0]!["time_window"]).toBe("7d");
    expect(stub.bodies.whale[0]!["time_window"]).toBe("24h");
  });
});

describe("polymarketSmartSheet — input contract", () => {
  it("the loyal buyer's fossilized body gets the full default sheet", async () => {
    const stub = makeStub();
    const res = await polymarketSmartSheet({
      body: Buffer.from(
        JSON.stringify({
          input_token: "So11111111111111111111111111111111111111112",
          slippage_bps: 100,
        }),
      ),
      method: "POST",
      fetchImpl: stub.fetchImpl,
    });
    expect(res.status).toBe(200);
    const body = res.body as SheetBody;
    expect(body.sheet).toHaveLength(7);
    expect(body.verdict.top_pick?.market_id).toBe("mA");
    expect(stub.bodies.bias[0]).toEqual({
      category: "all",
      time_window: "24h",
      limit: 100,
    });
  });

  it("limit is honored end-to-end", async () => {
    const stub = makeStub();
    const res = await polymarketSmartSheet({
      body: Buffer.from('{"limit":2}'),
      method: "POST",
      fetchImpl: stub.fetchImpl,
    });
    const body = res.body as SheetBody;
    expect(body.sheet).toHaveLength(2);
    expect(body.data_quality.sheet_rows).toBe(2);
  });

  it("wrong-typed known field -> 422 with input_schema, zero upstream calls", async () => {
    const res = await polymarketSmartSheet({
      body: Buffer.from('{"limit":"twenty"}'),
      method: "POST",
      fetchImpl: neverFetch,
    });
    expect(res.status).toBe(422);
    const body = res.body as { error: string; input_schema: unknown };
    expect(body.error).toBe("invalid_limit");
    expect(body.input_schema).toBeDefined();
  });
});

describe("polymarketSmartSheet — degradation & fail-closed", () => {
  it("whale-entries down -> 200 with stale_sources, null whale columns", async () => {
    const stub = makeStub({ whale: () => new Response("", { status: 502 }) });
    const res = await polymarketSmartSheet({
      body: null,
      method: "POST",
      fetchImpl: stub.fetchImpl,
    });
    expect(res.status).toBe(200);
    const body = res.body as SheetBody;
    expect(body.data_quality.stale_sources).toEqual(["whale_entries"]);
    expect(body.data_quality.sources["whale_entries"]).toBe("unavailable");
    expect(body.sheet[0]!.whale_entries).toBeNull();
    // Skill joins THROUGH whale hashes, so it degrades with them.
    expect(body.sheet[0]!.skill_positioning).toBeNull();
    expect(body.signals.whale_totals).toBeNull();
    expect(body.signals.sources_used).not.toContain("whale_entries");
    expect(body.verdict.confidence).toBe("medium");
  });

  it("trader-skill down -> 200, whale columns survive", async () => {
    const stub = makeStub({ skill: () => new Response("", { status: 500 }) });
    const res = await polymarketSmartSheet({
      body: null,
      method: "POST",
      fetchImpl: stub.fetchImpl,
    });
    expect(res.status).toBe(200);
    const body = res.body as SheetBody;
    expect(body.data_quality.stale_sources).toEqual(["trader_skill"]);
    expect(body.sheet[0]!.whale_entries).not.toBeNull();
    expect(body.sheet[0]!.skill_positioning).toBeNull();
    expect(body.signals.skill_coverage).toBeNull();
  });

  it("all position-holders calls down -> 200, holders unavailable", async () => {
    const stub = makeStub({ holders: () => new Response("", { status: 503 }) });
    const res = await polymarketSmartSheet({
      body: null,
      method: "POST",
      fetchImpl: stub.fetchImpl,
    });
    expect(res.status).toBe(200);
    const body = res.body as SheetBody;
    expect(body.data_quality.stale_sources).toEqual(["position_holders"]);
    expect(body.data_quality.sources["position_holders"]).toBe("unavailable");
    expect(body.sheet.every((r) => r.holder_concentration === null)).toBe(true);
    expect(stub.calls.holders).toBeLessThanOrEqual(5);
  });

  it("smart-bias down without preflight data -> 503 (direct-invocation guard)", async () => {
    const stub = makeStub({ bias: () => new Response("", { status: 503 }) });
    const res = await polymarketSmartSheet({
      body: null,
      method: "POST",
      fetchImpl: stub.fetchImpl,
    });
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toBe("critical_source_unavailable");
  });
});

describe("polymarketSmartSheet — preflightData reuse", () => {
  it("does NOT re-fetch smart-bias when the preflight already proved it", async () => {
    const stub = makeStub();
    const pf = await polymarketSmartSheetPreflight({
      body: Buffer.from('{"category":"crypto"}'),
      method: "POST",
      fetchImpl: stub.fetchImpl,
    });
    expect(pf.proceed).toBe(true);
    expect(stub.calls.bias).toBe(1);
    const res = await polymarketSmartSheet({
      body: Buffer.from('{"category":"crypto"}'),
      method: "POST",
      fetchImpl: stub.fetchImpl,
      preflightData: pf.proceed ? pf.data : undefined,
    });
    expect(res.status).toBe(200);
    expect(stub.calls.bias).toBe(1); // reused, not recomputed
  });

  it("refetches when preflight data belongs to different filters", async () => {
    const stub = makeStub();
    const pf = await polymarketSmartSheetPreflight({
      body: Buffer.from('{"category":"crypto"}'),
      method: "POST",
      fetchImpl: stub.fetchImpl,
    });
    expect(pf.proceed).toBe(true);
    const res = await polymarketSmartSheet({
      body: Buffer.from('{"category":"politics"}'),
      method: "POST",
      fetchImpl: stub.fetchImpl,
      preflightData: pf.proceed ? pf.data : undefined,
    });
    expect(res.status).toBe(200);
    expect(stub.calls.bias).toBe(2); // stale preflight ignored
  });
});
