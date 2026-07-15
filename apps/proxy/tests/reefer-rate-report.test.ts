import { describe, expect, it } from "vitest";
import {
  parseReeferQuery,
  reeferRateReport,
  reeferRateReportPreflight,
  reeferRateReportValidator,
  matchRegions,
  matchDestination,
  trendWord,
  type ReeferDoc,
} from "../src/handlers/reefer-rate-report.js";
import type { DbQuerier, InternalHandlerInput } from "../src/handlers/types.js";

function buf(v: unknown): Buffer {
  return Buffer.from(JSON.stringify(v), "utf8");
}

const DOC: ReeferDoc = {
  report_date: "2026-07-14",
  fetched_at: "2026-07-15T19:00:00Z",
  source: "https://www.ams.usda.gov/mnreports/fvwtrk.pdf",
  regions: [
    {
      region: "SALINAS-WATSONVILLE CALIFORNIA",
      last_report: false,
      commodities: ["BROCCOLI", "CAULIFLOWER", "LETTUCE, ICEBERG", "STRAWBERRIES"],
      lanes: [
        {
          destination: "Chicago",
          availability: "Slight Shortage",
          rate_low_usd: 6300,
          rate_high_usd: 6700,
          mostly_low_usd: null,
          mostly_high_usd: null,
          pct_change_wow: -4,
        },
        {
          destination: "New York",
          availability: "Slight Shortage",
          rate_low_usd: 11900,
          rate_high_usd: 12900,
          mostly_low_usd: null,
          mostly_high_usd: null,
          pct_change_wow: 2,
        },
      ],
    },
    {
      region: "MEXICO CROSSINGS THROUGH SOUTH TEXAS",
      last_report: false,
      commodities: ["AVOCADOS", "LIMES"],
      lanes: [
        {
          destination: "Chicago",
          availability: "Adequate",
          rate_low_usd: 4000,
          rate_high_usd: 4400,
          mostly_low_usd: 4100,
          mostly_high_usd: 4300,
          pct_change_wow: 12,
        },
      ],
    },
    {
      region: "MEXICO CROSSINGS THROUGH NOGALES ARIZONA",
      last_report: true,
      commodities: ["MANGOES"],
      lanes: [
        {
          destination: "Los Angeles",
          availability: "Adequate",
          rate_low_usd: 1500,
          rate_high_usd: 1700,
          mostly_low_usd: null,
          mostly_high_usd: null,
          pct_change_wow: 0,
        },
      ],
    },
  ],
};

describe("parse / validator", () => {
  it("discovery for empty and placeholder bodies", () => {
    expect(parseReeferQuery(null).kind).toBe("discovery");
    expect(parseReeferQuery(buf({})).kind).toBe("discovery");
    expect(parseReeferQuery(buf({ origin: "example" })).kind).toBe("discovery");
    expect(reeferRateReportValidator(buf({}), "POST")).toBeNull();
  });
  it("requires origin when only destination is given", () => {
    const r = reeferRateReportValidator(buf({ destination: "Chicago" }), "POST");
    expect(r?.status).toBe(422);
  });
});

describe("matching", () => {
  it("fuzzy-matches regions", () => {
    expect(matchRegions(DOC, "salinas").map((r) => r.region)).toEqual([
      "SALINAS-WATSONVILLE CALIFORNIA",
    ]);
    expect(matchRegions(DOC, "south texas").map((r) => r.region)).toEqual([
      "MEXICO CROSSINGS THROUGH SOUTH TEXAS",
    ]);
    expect(matchRegions(DOC, "narnia")).toEqual([]);
    // "mexico crossings" is ambiguous — both must surface.
    expect(matchRegions(DOC, "mexico crossings").length).toBe(2);
  });
  it("matches destinations within a region", () => {
    const region = matchRegions(DOC, "salinas")[0]!;
    expect(matchDestination(region, "chicago")[0]!.rate_low_usd).toBe(6300);
    expect(matchDestination(region, "denver")).toEqual([]);
  });
  it("maps trend words", () => {
    expect(trendWord(12)).toBe("up sharply");
    expect(trendWord(4)).toBe("up");
    expect(trendWord(0)).toBe("flat");
    expect(trendWord(-4)).toBe("down");
    expect(trendWord(-16)).toBe("down sharply");
  });
});

// ─────────────────────────────────────────────────────────────────────
// e2e over a db stub carrying the stored report
// ─────────────────────────────────────────────────────────────────────

function makeDbStub(opts: { missing?: boolean; staleFetch?: boolean } = {}): DbQuerier {
  return {
    async query(text: string) {
      if (text.includes("freight_http_cache") && text.startsWith("SELECT")) {
        if (opts.missing) return { rows: [] };
        return {
          rows: [
            {
              payload: DOC,
              fetched_at: opts.staleFetch
                ? new Date(Date.now() - 20 * 86_400_000).toISOString()
                : new Date().toISOString(),
            },
          ],
        };
      }
      return { rows: [] };
    },
  };
}

function makeInput(body: unknown, opts: Parameters<typeof makeDbStub>[0] = {}): InternalHandlerInput {
  return { body: buf(body), method: "POST", db: makeDbStub(opts) };
}

describe("preflight + handler e2e", () => {
  it("returns the lane verdict for origin+destination", async () => {
    const inp = makeInput({ origin: "salinas", destination: "Chicago" });
    const pf = await reeferRateReportPreflight(inp);
    expect(pf.proceed).toBe(true);
    const res = await reeferRateReport({
      ...inp,
      preflightData: (pf as { proceed: true; data?: unknown }).data,
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body["verdict"]["truck_availability"]).toBe("SLIGHT_SHORTAGE");
    expect(body["verdict"]["rate_range_usd_per_load"]).toEqual([6300, 6700]);
    expect(body["verdict"]["trend"]).toBe("down");
    expect(body["data_quality"]["report_date"]).toBe("2026-07-14");
    expect(body["data_quality"]["scope"]).toMatch(/NOT a general dry-van/);
  });

  it("returns all lanes when destination is omitted", async () => {
    const inp = makeInput({ origin: "salinas" });
    const pf = await reeferRateReportPreflight(inp);
    expect(pf.proceed).toBe(true);
    const res = await reeferRateReport({
      ...inp,
      preflightData: (pf as { proceed: true; data?: unknown }).data,
    });
    const body = res.body as Record<string, any>;
    expect(body["lanes"].length).toBe(2);
    expect(body["verdict"]["rate_range_usd_per_load"]).toBeNull();
  });

  it("flags LAST REPORT regions with medium confidence", async () => {
    const inp = makeInput({ origin: "nogales" });
    const pf = await reeferRateReportPreflight(inp);
    const res = await reeferRateReport({
      ...inp,
      preflightData: (pf as { proceed: true; data?: unknown }).data,
    });
    const body = res.body as Record<string, any>;
    expect(body["verdict"]["confidence"]).toBe("medium");
    expect(body["data_quality"]["region_is_last_report"]).toBe(true);
  });

  it("free 422 with the full region menu for unknown origins", async () => {
    const pf = await reeferRateReportPreflight(makeInput({ origin: "narnia central" }));
    expect(pf.proceed).toBe(false);
    const r = pf as { status?: number; body?: Record<string, unknown> };
    expect(r.status).toBe(422);
    expect((r.body!["available_regions"] as string[]).length).toBe(3);
  });

  it("free 422 with candidates for ambiguous origins", async () => {
    const pf = await reeferRateReportPreflight(makeInput({ origin: "mexico crossings" }));
    expect(pf.proceed).toBe(false);
    expect(((pf as { body?: Record<string, unknown> }).body!["candidates"] as string[]).length).toBe(2);
  });

  it("free 422 with destination menu for unknown destinations", async () => {
    const pf = await reeferRateReportPreflight(
      makeInput({ origin: "salinas", destination: "Denver" }),
    );
    expect(pf.proceed).toBe(false);
    expect(
      ((pf as { body?: Record<string, unknown> }).body!["available_destinations"] as string[]),
    ).toEqual(["Chicago", "New York"]);
  });

  it("fails closed when the report is missing or stale", async () => {
    const missing = await reeferRateReportPreflight(
      makeInput({ origin: "salinas" }, { missing: true }),
    );
    expect(missing.proceed).toBe(false);
    expect((missing as { status?: number }).status).toBe(503);
    const stale = await reeferRateReportPreflight(
      makeInput({ origin: "salinas" }, { staleFetch: true }),
    );
    expect(stale.proceed).toBe(false);
    expect((stale as { status?: number }).status).toBe(503);
  });
});
