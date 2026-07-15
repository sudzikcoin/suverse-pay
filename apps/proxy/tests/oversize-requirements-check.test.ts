import { describe, expect, it } from "vitest";
import {
  parseOversizeQuery,
  oversizeValidator,
  assessEscorts,
  assessState,
  computeOversizeVerdict,
  loadOversizeRules,
  oversizePreflight,
  oversizeRequirementsCheck,
  type OversizeLoad,
  type StateRules,
  type StateAssessment,
} from "../src/handlers/oversize-requirements-check.js";
import type { DbQuerier, InternalHandlerInput } from "../src/handlers/types.js";

function buf(v: unknown): Buffer {
  return Buffer.from(JSON.stringify(v), "utf8");
}

const LEGAL_LOAD: OversizeLoad = {
  width_ft: 8.5,
  height_ft: 13.5,
  length_ft: 70,
  gross_weight_lbs: 80_000,
  axles: 5,
};

const WIDE_LOAD: OversizeLoad = { ...LEGAL_LOAD, width_ft: 12.5 };

const SUPERLOAD: OversizeLoad = {
  width_ft: 16,
  height_ft: 15.5,
  length_ft: 140,
  gross_weight_lbs: 200_000,
  axles: 9,
};

/** Synthetic state with a known-tricky escort matrix. */
function fixtureState(over: Partial<StateRules> = {}): StateRules {
  return {
    state: "ZZ",
    state_name: "Testalia",
    source_url: "https://dot.zz.gov/osow",
    portal_url: "https://permits.zz.gov",
    retrieved_at: "2026-07-15",
    rules_as_of: "2026-07-15",
    verification: "live_checked",
    data_quality: "ok",
    verify_reasons: [],
    legal_limits: { width_ft: 8.5, height_ft: 13.5, length_semitrailer_ft: 53, gross_weight_lbs: 80_000 },
    superload_thresholds: { width_ft: 16, height_ft: 15.99, length_ft: 120, gross_weight_lbs: 150_000, note: null },
    escort_rules: {
      width: [
        { over_ft: 10, up_to_ft: 12, escorts: 1, police: false, note: "rear on divided" },
        { over_ft: 12, up_to_ft: 14, escorts: 1, police: false, note: "front and rear on 2-lane" },
        { over_ft: 14, up_to_ft: null, escorts: 2, police: false, note: null },
      ],
      height: [{ over_ft: 14.5, up_to_ft: null, escorts: 1, police: false, pole_car: true, note: null }],
      length: [{ over_ft: 90, up_to_ft: null, escorts: 1, police: false, note: "rear" }],
      weight: [{ over_ft: 180_000, up_to_ft: null, escorts: 0, police: true, note: "police above 180k" }],
    },
    permit_types: {
      single_trip: { available: true, fee_usd_min: 20, fee_usd_max: 60, fee_formula: null, validity_days: 5, note: null },
      annual: { available: true, fee_usd_min: 400, fee_usd_max: 400, note: null },
    },
    movement_restrictions: ["No movement sunset to sunrise", "No Sunday travel over 12 ft wide"],
    notes: [],
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Input parsing
// ─────────────────────────────────────────────────────────────────────

describe("parseOversizeQuery", () => {
  const base = {
    width_ft: 12,
    height_ft: 14,
    length_ft: 90,
    gross_weight_lbs: 120_000,
    origin: "Chicago, IL",
    destination: "Houston, TX",
  };

  it("parses decimal feet", () => {
    const p = parseOversizeQuery(buf(base));
    expect(p.kind).toBe("query");
    if (p.kind !== "query") return;
    expect(p.query.load.width_ft).toBe(12);
    expect(p.query.load.axles).toBeNull();
  });

  it("adds feet+inches (12 ft 6 in = 12.5)", () => {
    const p = parseOversizeQuery(buf({ ...base, width_ft: 12, width_in: 6 }));
    expect(p.kind).toBe("query");
    if (p.kind !== "query") return;
    expect(p.query.load.width_ft).toBeCloseTo(12.5, 6);
  });

  it("treats _in as the fractional-inches part (0-11) on top of _ft", () => {
    const p = parseOversizeQuery(buf({ ...base, height_ft: 14, height_in: 9 }));
    expect(p.kind).toBe("query");
    if (p.kind !== "query") return;
    expect(p.query.load.height_ft).toBeCloseTo(14.75, 6);
  });

  it("rejects an inches value of 12 or more (belongs in feet)", () => {
    const p = parseOversizeQuery(buf({ ...base, width_ft: 12, width_in: 18 }));
    expect(p.kind).toBe("invalid_value");
    expect((p as { field?: string }).field).toBe("width");
  });

  it("empty body is discovery, not an error", () => {
    expect(parseOversizeQuery(null).kind).toBe("discovery");
    expect(parseOversizeQuery(Buffer.from("", "utf8")).kind).toBe("discovery");
    expect(parseOversizeQuery(buf({})).kind).toBe("discovery");
  });

  it("rejects missing dimensions and weight with the field named", () => {
    const noW = parseOversizeQuery(buf({ ...base, width_ft: undefined }));
    expect(noW.kind).toBe("invalid_value");
    expect((noW as { field?: string }).field).toBe("width");
    const noGw = parseOversizeQuery(buf({ ...base, gross_weight_lbs: undefined }));
    expect((noGw as { field?: string }).field).toBe("gross_weight_lbs");
  });

  it("rejects implausible values", () => {
    expect(parseOversizeQuery(buf({ ...base, width_ft: 55 })).kind).toBe("invalid_value");
    expect(parseOversizeQuery(buf({ ...base, gross_weight_lbs: 5_000 })).kind).toBe("invalid_value");
    expect(parseOversizeQuery(buf({ ...base, axles: 1 })).kind).toBe("invalid_value");
    expect(parseOversizeQuery(buf({ ...base, width_in: -4 })).kind).toBe("invalid_value");
  });

  it("requires origin and destination", () => {
    const p = parseOversizeQuery(buf({ ...base, destination: undefined }));
    expect(p.kind).toBe("invalid_value");
    expect((p as { field?: string }).field).toBe("destination");
  });
});

describe("oversizeValidator", () => {
  it("400s broken JSON, 422s wrong shapes, passes discovery + valid", () => {
    expect(oversizeValidator(Buffer.from("{nope", "utf8"), "POST")?.status).toBe(400);
    expect(oversizeValidator(buf([1, 2]), "POST")?.status).toBe(422);
    expect(oversizeValidator(buf({ width_ft: 99 }), "POST")?.status).toBe(422);
    expect(oversizeValidator(null, "POST")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Escort matrix + per-state assessment
// ─────────────────────────────────────────────────────────────────────

describe("assessEscorts", () => {
  const rules = fixtureState();

  it("picks the right width band (half-open ranges)", () => {
    expect(assessEscorts(rules, { ...LEGAL_LOAD, width_ft: 11 }).pilots).toBe(1);
    // exactly 12 stays in the (10, 12] band, not the next one
    const at12 = assessEscorts(rules, { ...LEGAL_LOAD, width_ft: 12 });
    expect(at12.pilots).toBe(1);
    expect(at12.matched_rules).toHaveLength(1);
    expect(at12.matched_rules[0]!.rule.up_to_ft).toBe(12);
    expect(assessEscorts(rules, { ...LEGAL_LOAD, width_ft: 14.01 }).pilots).toBe(2);
  });

  it("takes the max pilots across dimensions, not the sum", () => {
    const a = assessEscorts(rules, { ...LEGAL_LOAD, width_ft: 15, length_ft: 95 });
    expect(a.pilots).toBe(2);
    expect(a.matched_rules.map((m) => m.dimension).sort()).toEqual(["length", "width"]);
  });

  it("reports pole car and police flags in the label", () => {
    const tall = assessEscorts(rules, { ...LEGAL_LOAD, height_ft: 15 });
    expect(tall.pole_car).toBe(true);
    expect(tall.label).toContain("pole car");
    const heavy = assessEscorts(rules, { ...LEGAL_LOAD, gross_weight_lbs: 190_000 });
    expect(heavy.police).toBe(true);
    expect(heavy.label).toContain("police");
  });

  it("legal load needs nothing", () => {
    expect(assessEscorts(rules, LEGAL_LOAD).label).toBe("none");
  });
});

describe("assessState", () => {
  const rules = fixtureState();

  it("legal load: no permit, no fee, no restrictions echoed", () => {
    const a = assessState(rules, LEGAL_LOAD);
    expect(a.permit_required).toBe(false);
    expect(a.triggered_by).toEqual([]);
    expect(a.permit_type).toBe("none");
    expect(a.fee_estimate.usd_min).toBeNull();
    expect(a.movement_restrictions).toEqual([]);
    expect(a.superload_threshold_hit).toBe(false);
  });

  it("12'6\" wide: permit + escorts + fee estimate always verify_with_state", () => {
    const a = assessState(rules, WIDE_LOAD);
    expect(a.permit_required).toBe(true);
    expect(a.triggered_by).toEqual(["width"]);
    expect(a.escort_requirements).toBe("1 pilot");
    expect(a.fee_estimate.usd_min).toBe(20);
    expect(a.fee_estimate.verify_with_state).toBe(true);
    expect(a.movement_restrictions.length).toBeGreaterThan(0);
  });

  it("superload: threshold hit on any dimension at-or-above", () => {
    const a = assessState(rules, SUPERLOAD);
    expect(a.superload_threshold_hit).toBe(true);
    expect(a.triggered_by).toEqual(["width", "height", "length", "weight"]);
  });

  it("length trigger uses max(75, semitrailer limit) so a 70 ft combo stays legal", () => {
    const a = assessState(rules, { ...LEGAL_LOAD, length_ft: 74.9 });
    expect(a.permit_required).toBe(false);
    const b = assessState(rules, { ...LEGAL_LOAD, length_ft: 76 });
    expect(b.triggered_by).toEqual(["length"]);
  });

  it("null superload thresholds + screening-size load → uncertain, not a fake verdict", () => {
    const noSl = fixtureState({
      superload_thresholds: { width_ft: null, height_ft: null, length_ft: null, gross_weight_lbs: null, note: null },
    });
    const a = assessState(noSl, SUPERLOAD);
    expect(a.superload_threshold_hit).toBe(false);
    expect(a.superload_uncertain).toBe(true);
  });

  it("formula fee states return the formula, never a number", () => {
    const formulaState = fixtureState({
      permit_types: {
        single_trip: {
          available: true,
          fee_usd_min: null,
          fee_usd_max: null,
          fee_formula: "base $30 + $0.05 per ton-mile over legal; inputs: miles, excess_tons",
          validity_days: 5,
          note: null,
        },
        annual: { available: false, note: null },
      },
    });
    const a = assessState(formulaState, WIDE_LOAD);
    expect(a.fee_estimate.usd_min).toBeNull();
    expect(a.fee_estimate.formula).toContain("ton-mile");
  });
});

describe("computeOversizeVerdict ladder", () => {
  const rules = fixtureState();
  const assess = (load: OversizeLoad): StateAssessment[] => [assessState(rules, load)];

  it("LEGAL under limits everywhere", () => {
    expect(computeOversizeVerdict(assess(LEGAL_LOAD)).status).toBe("LEGAL");
  });
  it("PERMITS_REQUIRED over legal but under superload", () => {
    expect(computeOversizeVerdict(assess(WIDE_LOAD)).status).toBe("PERMITS_REQUIRED");
  });
  it("SUPERLOAD_REVIEW when any state's threshold is hit", () => {
    const v = computeOversizeVerdict(assess(SUPERLOAD));
    expect(v.status).toBe("SUPERLOAD_REVIEW");
    expect(v.flags.join(" ")).toContain("superload_threshold_hit_in_ZZ");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Real dataset — coverage + sanity
// ─────────────────────────────────────────────────────────────────────

const LOWER_48_PLUS_DC = [
  "AL", "AR", "AZ", "CA", "CO", "CT", "DC", "DE", "FL", "GA", "IA", "ID",
  "IL", "IN", "KS", "KY", "LA", "MA", "MD", "ME", "MI", "MN", "MO", "MS",
  "MT", "NC", "ND", "NE", "NH", "NJ", "NM", "NV", "NY", "OH", "OK", "OR",
  "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VA", "VT", "WA", "WI", "WV", "WY",
];

describe("shipped oversize-rules dataset", () => {
  const rules = loadOversizeRules();

  it("covers all lower-48 states + DC (49 jurisdictions)", () => {
    const have = [...rules.keys()].sort();
    expect(have).toEqual(LOWER_48_PLUS_DC);
  });

  it("every entry passes structural sanity (loader validates on read)", () => {
    for (const [code, r] of rules) {
      expect(r.state).toBe(code);
      expect(r.legal_limits.width_ft).toBeGreaterThanOrEqual(8);
      expect(r.legal_limits.width_ft).toBeLessThanOrEqual(9);
      expect(r.legal_limits.height_ft).toBeGreaterThanOrEqual(13);
      expect(r.legal_limits.height_ft).toBeLessThanOrEqual(15);
      expect(r.legal_limits.gross_weight_lbs).toBeGreaterThanOrEqual(80_000);
      expect(r.source_url).toMatch(/^https?:\/\//);
    }
  });

  it("a federal-legal load is LEGAL in every covered state", () => {
    for (const [, r] of rules) {
      const a = assessState(r, LEGAL_LOAD);
      expect(a.permit_required, `${r.state} flags a legal load`).toBe(false);
    }
  });

  it("a 16 ft / 200k lbs load is superload or explicitly uncertain everywhere", () => {
    for (const [, r] of rules) {
      const a = assessState(r, SUPERLOAD);
      expect(
        a.superload_threshold_hit || a.superload_uncertain,
        `${r.state} silently passes a 200k lbs superload`,
      ).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// e2e through preflight + handler with stubbed geocoder/NWS
// ─────────────────────────────────────────────────────────────────────

function makeDbStub(): DbQuerier {
  return {
    async query() {
      return { rows: [] };
    },
  };
}

/** /points/<lat>,<lon> → state by latitude band along the CHI→ATL corridor. */
function makeFetchStub(opts: { geocodeEmpty?: boolean; nwsDown?: boolean } = {}): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const u = String(url);
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (u.includes("nominatim")) {
      if (opts.geocodeEmpty) return json([]);
      if (u.includes("Chicago")) {
        return json([{ lat: "41.8781", lon: "-87.6298", display_name: "Chicago, Cook County, Illinois" }]);
      }
      return json([{ lat: "33.749", lon: "-84.388", display_name: "Atlanta, Fulton County, Georgia" }]);
    }
    if (u.includes("/points/")) {
      if (opts.nwsDown) return json({ detail: "down" }, 503);
      const lat = Number(/points\/(-?\d+\.\d+),/.exec(u)?.[1] ?? "0");
      const state = lat > 40 ? "IL" : lat > 36 ? "IN" : "GA";
      return json({ properties: { relativeLocation: { properties: { state } } } });
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
}

function makeInput(body: unknown, opts: Parameters<typeof makeFetchStub>[0] = {}): InternalHandlerInput {
  return { body: buf(body), method: "POST", db: makeDbStub(), fetchImpl: makeFetchStub(opts) };
}

const ROUTE = { origin: "Chicago, IL", destination: "Atlanta, GA" };

describe("preflight + handler e2e (stubbed route, real dataset)", () => {
  it("fixture 1 — legal load: LEGAL across IL/IN/GA, no fees, no escorts", async () => {
    const inp = makeInput({ ...LEGAL_LOAD, ...ROUTE });
    const pf = await oversizePreflight(inp);
    expect(pf.proceed).toBe(true);
    const res = await oversizeRequirementsCheck({
      ...inp,
      preflightData: (pf as { proceed: true; data?: unknown }).data,
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body["verdict"]["status"]).toBe("LEGAL");
    expect(body["route"]["states_crossed"]).toEqual(["IL", "IN", "GA"]);
    expect(body["states"]).toHaveLength(3);
    expect(body["states"].every((s: StateAssessment) => !s.permit_required)).toBe(true);
    expect(body["scope"]["disclaimer"]).toContain("NOT a permit");
  });

  it("fixture 2 — 12'6\" wide: PERMITS_REQUIRED with per-state escorts + verify-flagged fees", async () => {
    const inp = makeInput({ ...WIDE_LOAD, width_ft: 12, width_in: 6, ...ROUTE });
    const pf = await oversizePreflight(inp);
    expect(pf.proceed).toBe(true);
    const res = await oversizeRequirementsCheck({
      ...inp,
      preflightData: (pf as { proceed: true; data?: unknown }).data,
    });
    const body = res.body as Record<string, any>;
    expect(body["verdict"]["status"]).toBe("PERMITS_REQUIRED");
    expect(body["verdict"]["states_requiring_permits"]).toEqual(["IL", "IN", "GA"]);
    for (const s of body["states"] as StateAssessment[]) {
      expect(s.triggered_by).toContain("width");
      expect(s.fee_estimate.verify_with_state).toBe(true);
      expect(s.source_url).toMatch(/^https?:\/\//);
      expect(s.rules_as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("fixture 3 — 16 ft / 200k lbs: SUPERLOAD_REVIEW, honest about engineering review", async () => {
    const inp = makeInput({ ...SUPERLOAD, ...ROUTE });
    const pf = await oversizePreflight(inp);
    expect(pf.proceed).toBe(true);
    const res = await oversizeRequirementsCheck({
      ...inp,
      preflightData: (pf as { proceed: true; data?: unknown }).data,
    });
    const body = res.body as Record<string, any>;
    expect(body["verdict"]["status"]).toBe("SUPERLOAD_REVIEW");
    expect(body["verdict"]["summary"]).toContain("SUPERLOAD");
  });

  it("422s unresolvable origins before settlement", async () => {
    const inp = makeInput({ ...LEGAL_LOAD, origin: "Nowhereville Zzz", destination: "Atlanta, GA" }, { geocodeEmpty: true });
    const pf = await oversizePreflight(inp);
    expect(pf.proceed).toBe(false);
    expect((pf as { status?: number }).status).toBe(422);
  });

  it("fails closed (503) when state resolution is down — buyer never charged", async () => {
    const inp = makeInput({ ...LEGAL_LOAD, origin: "41.8781,-87.6298", destination: "33.749,-84.388" }, { nwsDown: true });
    const pf = await oversizePreflight(inp);
    expect(pf.proceed).toBe(false);
    expect((pf as { status?: number }).status).toBe(503);
  });

  it("422s zero-length routes", async () => {
    const inp = makeInput({ ...LEGAL_LOAD, origin: "41.88,-87.63", destination: "41.88,-87.63" });
    const pf = await oversizePreflight(inp);
    expect(pf.proceed).toBe(false);
    expect((pf as { status?: number }).status).toBe(422);
  });
});
