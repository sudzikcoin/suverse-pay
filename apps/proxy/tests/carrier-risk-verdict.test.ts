import { describe, expect, it } from "vitest";
import {
  parseCarrierQuery,
  carrierRiskVerdict,
  carrierRiskVerdictPreflight,
  carrierRiskVerdictValidator,
  assessAuthority,
  assessInsurance,
  assessSafety,
  assessFraudSignals,
  computeVerdict,
} from "../src/handlers/carrier-risk-verdict.js";
import {
  normalizeDocket,
  normalizeDot,
  type AuthorityStatus,
  type CensusRow,
  type InspectionSummary,
  type CachedLookup,
} from "../src/handlers/fmcsa-shared.js";
import type { DbQuerier, InternalHandlerInput } from "../src/handlers/types.js";

const NOW = new Date("2026-07-15T12:00:00Z");

function buf(v: unknown): Buffer {
  return Buffer.from(JSON.stringify(v), "utf8");
}

// ─────────────────────────────────────────────────────────────────────
// Identifier normalization + input parsing
// ─────────────────────────────────────────────────────────────────────

describe("normalization", () => {
  it("normalizes docket forms", () => {
    expect(normalizeDocket("MC-424836")).toBe("MC424836");
    expect(normalizeDocket("mc 424836")).toBe("MC424836");
    expect(normalizeDocket("424836")).toBe("MC424836");
    expect(normalizeDocket("FF10096")).toBe("FF10096");
    expect(normalizeDocket("not a docket")).toBeNull();
  });
  it("normalizes DOT forms", () => {
    expect(normalizeDot("264184")).toBe("264184");
    expect(normalizeDot("USDOT# 0264184")).toBe("264184");
    expect(normalizeDot("26x4184")).toBeNull();
  });
});

describe("parseCarrierQuery / validator", () => {
  it("classifies empty and placeholder bodies as discovery", () => {
    expect(parseCarrierQuery(null).kind).toBe("discovery");
    expect(parseCarrierQuery(Buffer.from("", "utf8")).kind).toBe("discovery");
    expect(parseCarrierQuery(buf({})).kind).toBe("discovery");
    expect(parseCarrierQuery(buf({ dot: "string" })).kind).toBe("discovery");
    expect(parseCarrierQuery(buf({ name: "<carrier name>" })).kind).toBe("discovery");
    expect(carrierRiskVerdictValidator(buf({}), "POST")).toBeNull();
  });
  it("accepts dot / mc / name and alias keys", () => {
    expect(parseCarrierQuery(buf({ dot: "264184" }))).toEqual({
      kind: "query",
      query: { kind: "dot", dot: "264184" },
    });
    expect(parseCarrierQuery(buf({ usdot: "264184" }))).toEqual({
      kind: "query",
      query: { kind: "dot", dot: "264184" },
    });
    const mc = parseCarrierQuery(buf({ mc: "MC-133655" }));
    expect(mc).toEqual({
      kind: "query",
      query: { kind: "mc", docketNorm: "MC133655", raw: "MC-133655" },
    });
    expect(parseCarrierQuery(buf({ name: "SCHNEIDER NATIONAL CARRIERS" })).kind).toBe(
      "query",
    );
  });
  it("rejects real-but-invalid values with 422 and bad JSON with 400", () => {
    const r = carrierRiskVerdictValidator(buf({ dot: "abc123x" }), "POST");
    expect(r?.status).toBe(422);
    const j = carrierRiskVerdictValidator(Buffer.from("{nope", "utf8"), "POST");
    expect(j?.status).toBe(400);
    const arr = carrierRiskVerdictValidator(buf([1, 2]), "POST");
    expect(arr?.status).toBe(422);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Component assessments (pure)
// ─────────────────────────────────────────────────────────────────────

const ACTIVE_CARRIER: AuthorityStatus = {
  op_auth_type: "Motor Carrier of Property (Except Household Goods)",
  op_auth_status: "Active",
  reason: "GRANTED",
  status_change_date: "1987-06-01",
};

describe("assessAuthority", () => {
  it("scores an old active carrier 100", () => {
    const a = assessAuthority([ACTIVE_CARRIER], [], [], "1987-06-01", NOW);
    expect(a.score).toBe(100);
    expect(a.active_carrier_authority).toBe(true);
    expect(a.flags).toEqual([]);
  });
  it("flags an involuntary suspension in force", () => {
    const a = assessAuthority(
      [ACTIVE_CARRIER],
      [],
      [
        {
          op_auth_type: "Motor Carrier of Property (Except Household Goods)",
          order_type: "Operating Authority Involuntary Suspension Notice",
          serve_date: "2026-05-21",
          effective_date: "2026-06-20",
        },
      ],
      "1987-06-01",
      NOW,
    );
    expect(a.active_involuntary_suspension).not.toBeNull();
    expect(a.flags).toContain("involuntary_suspension_in_force");
    expect(a.score).toBe(60);
  });
  it("treats a suspension followed by a later Active event as lifted", () => {
    const reinstated: AuthorityStatus = {
      ...ACTIVE_CARRIER,
      status_change_date: "2026-07-01",
    };
    const a = assessAuthority(
      [reinstated],
      [],
      [
        {
          op_auth_type: null,
          order_type: "Operating Authority Involuntary Suspension Notice",
          serve_date: "2026-05-21",
          effective_date: "2026-06-20",
        },
      ],
      "1987-06-01",
      NOW,
    );
    expect(a.active_involuntary_suspension).toBeNull();
  });
  it("flags broker-only dockets on a carrier check", () => {
    const a = assessAuthority(
      [
        {
          op_auth_type: "Broker of Property (Except Household Goods)",
          op_auth_status: "Active",
          reason: null,
          status_change_date: "2020-01-01",
        },
      ],
      [],
      [],
      "2020-01-01",
      NOW,
    );
    expect(a.broker_only).toBe(true);
    expect(a.score).toBe(20);
  });
  it("penalizes authority under 6 months", () => {
    const a = assessAuthority(
      [{ ...ACTIVE_CARRIER, status_change_date: "2026-05-01" }],
      [],
      [],
      "2026-05-01",
      NOW,
    );
    expect(a.flags).toContain("authority_under_6_months");
    expect(a.score).toBe(80);
  });
});

const REG_CARRIER = {
  docket_number: "MC123456",
  usdot_number: "999999",
  op_auth_type: "Motor Carrier of Property (Except Household Goods)",
  op_auth_status: "Active",
  legal_name: "TEST CARRIER LLC",
  dba_name: null,
  min_cov_amount: 750000,
  cargo_req: "N",
  bond_req: "N",
  bipd_file: "1000000",
  cargo_file: "N",
  bond_file: "N",
  bus_undeliverable_mail: "N",
  mail_undeliverable_mail: "N",
  bus_city: "OSWEGO",
  bus_state_code: "IL",
};

describe("assessInsurance", () => {
  const auth = assessAuthority([ACTIVE_CARRIER], [], [], "1987-06-01", NOW);
  it("scores coverage >= required 100", () => {
    const i = assessInsurance(
      [
        {
          form: "BMC-91X",
          type: "BIPD",
          max_coverage_usd: 1_000_000,
          underlying_limit_usd: 0,
          policy_no: "P1",
          effective_date: "2026-01-01",
          insurer: "ACME",
        },
      ],
      [REG_CARRIER],
      auth,
    );
    expect(i.score).toBe(100);
    expect(i.bipd_required_usd).toBe(750000);
  });
  it("flags underinsurance", () => {
    const i = assessInsurance(
      [
        {
          form: "BMC-91X",
          type: "BIPD",
          max_coverage_usd: 300_000,
          underlying_limit_usd: 0,
          policy_no: "P1",
          effective_date: "2026-01-01",
          insurer: "ACME",
        },
      ],
      [REG_CARRIER],
      auth,
    );
    expect(i.flags).toContain("bipd_below_required_minimum");
    expect(i.score).toBe(35);
  });
  it("treats decades-old carriers with no filing as possible self-insured", () => {
    const i = assessInsurance([], [REG_CARRIER], auth);
    expect(i.possible_self_insured).toBe(true);
    expect(i.score).toBe(40);
  });
  it("zero-scores a young carrier with nothing on file", () => {
    const young = assessAuthority(
      [{ ...ACTIVE_CARRIER, status_change_date: "2026-02-01" }],
      [],
      [],
      "2026-02-01",
      NOW,
    );
    const i = assessInsurance([], [REG_CARRIER], young);
    expect(i.score).toBe(0);
    expect(i.flags).toContain("no_bipd_on_file");
  });
});

function inspLookup(s: Partial<InspectionSummary>): CachedLookup<InspectionSummary> {
  return {
    value: {
      window_months: 24,
      inspection_count: 0,
      violation_total: 0,
      oos_total: 0,
      driver_oos_total: 0,
      vehicle_oos_total: 0,
      driver_oos_rate: null,
      vehicle_oos_rate: null,
      last_inspection_date: null,
      ...s,
    },
    source: "live",
    fetchedAt: NOW,
  };
}

describe("assessSafety", () => {
  const auth = assessAuthority([ACTIVE_CARRIER], [], [], "1987-06-01", NOW);
  it("nulls the component when inspections are unavailable", () => {
    const s = assessSafety(null, null, auth);
    expect(s.score).toBeNull();
    expect(s.flags).toContain("inspection_data_unavailable");
  });
  it("penalizes OOS rates above national averages", () => {
    const s = assessSafety(
      inspLookup({
        inspection_count: 20,
        vehicle_oos_total: 10,
        driver_oos_total: 4,
        vehicle_oos_rate: 0.5,
        driver_oos_rate: 0.2,
        violation_total: 30,
      }),
      null,
      auth,
    );
    expect(s.score).toBe(40);
    expect(s.flags).toContain("vehicle_oos_rate_over_1_5x_national");
    expect(s.flags).toContain("driver_oos_rate_over_1_5x_national");
  });
  it("marks a clean record 100", () => {
    const s = assessSafety(
      inspLookup({
        inspection_count: 50,
        vehicle_oos_rate: 0.1,
        driver_oos_rate: 0.01,
        violation_total: 40,
      }),
      null,
      auth,
    );
    expect(s.score).toBe(100);
  });
});

const CENSUS_OK: CensusRow = {
  dot_number: "999999",
  legal_name: "TEST CARRIER LLC",
  dba_name: null,
  status_code: "A",
  carrier_operation: "A",
  phy_city: "OSWEGO",
  phy_state: "IL",
  phy_country: "US",
  power_units: 12,
  truck_units: 12,
  total_drivers: 14,
  total_cdl: 14,
  mcs150_date: "2026-01-10",
  mcs150_mileage: 1_200_000,
  mcs150_mileage_year: "2025",
  add_date: "1990-01-01",
  undeliv_phy: "N",
};

describe("assessFraudSignals", () => {
  const auth = assessAuthority([ACTIVE_CARRIER], [], [], "1987-06-01", NOW);
  it("passes a clean census 100", () => {
    const f = assessFraudSignals(CENSUS_OK, [], [REG_CARRIER], auth, NOW);
    expect(f.score).toBe(100);
    expect(f.flags).toEqual([]);
  });
  it("flags stale MCS-150 + fleet jump as the CargoNet pattern", () => {
    const f = assessFraudSignals(
      { ...CENSUS_OK, mcs150_date: "2023-01-10" },
      [
        {
          snapshot_date: "2026-01-01",
          power_units: 3,
          total_drivers: 3,
          mcs150_date: "2023-01-10",
          mcs150_mileage: 100000,
        },
        {
          snapshot_date: "2026-07-15",
          power_units: 30,
          total_drivers: 32,
          mcs150_date: "2023-01-10",
          mcs150_mileage: 100000,
        },
      ],
      [REG_CARRIER],
      auth,
      NOW,
    );
    expect(f.flags).toContain("mcs150_filing_stale_over_2_years");
    expect(f.flags).toContain("fleet_size_jump_detected");
    expect(f.score).toBe(30);
  });
  it("flags undeliverable addresses (census undeliv_phy = 'U')", () => {
    const f = assessFraudSignals(
      { ...CENSUS_OK, undeliv_phy: "U" },
      [],
      [REG_CARRIER],
      auth,
      NOW,
    );
    expect(f.flags).toContain("undeliverable_address_on_file");
  });
});

describe("computeVerdict", () => {
  const auth = assessAuthority([ACTIVE_CARRIER], [], [], "1987-06-01", NOW);
  const okIns = assessInsurance(
    [
      {
        form: "BMC-91X",
        type: "BIPD",
        max_coverage_usd: 1_000_000,
        underlying_limit_usd: 0,
        policy_no: "P1",
        effective_date: "2026-01-01",
        insurer: "ACME",
      },
    ],
    [REG_CARRIER],
    auth,
  );
  const okSafety = assessSafety(
    inspLookup({ inspection_count: 50, vehicle_oos_rate: 0.1, driver_oos_rate: 0.01 }),
    CENSUS_OK,
    auth,
  );
  const okFraud = assessFraudSignals(CENSUS_OK, [], [REG_CARRIER], auth, NOW);

  it("HIREs a clean carrier", () => {
    const v = computeVerdict(auth, okIns, okSafety, okFraud);
    expect(v.decision).toBe("HIRE");
    expect(v.score).toBe(100);
    expect(v.hard_fail).toBeNull();
  });
  it("hard-AVOIDs a docket with no carrier authority", () => {
    const brokerAuth = assessAuthority(
      [
        {
          op_auth_type: "Broker of Property (Except Household Goods)",
          op_auth_status: "Active",
          reason: null,
          status_change_date: "2020-01-01",
        },
      ],
      [],
      [],
      "2020-01-01",
      NOW,
    );
    const v = computeVerdict(brokerAuth, okIns, okSafety, okFraud);
    expect(v.decision).toBe("AVOID");
    expect(v.hard_fail).toBe("no_carrier_authority_docket_is_broker_only");
  });
  it("hard-AVOIDs missing required BIPD", () => {
    const young = assessAuthority(
      [{ ...ACTIVE_CARRIER, status_change_date: "2026-02-01" }],
      [],
      [],
      "2026-02-01",
      NOW,
    );
    const noIns = assessInsurance([], [REG_CARRIER], young);
    const v = computeVerdict(young, noIns, okSafety, okFraud);
    expect(v.decision).toBe("AVOID");
    expect(v.hard_fail).toBe("required_bipd_insurance_not_on_file");
  });
  it("renormalizes weights when safety is null", () => {
    const nullSafety = assessSafety(null, CENSUS_OK, auth);
    const v = computeVerdict(auth, okIns, nullSafety, okFraud);
    expect(v.decision).toBe("HIRE");
    expect(v.score).toBe(100);
    expect(v.component_scores.safety).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// End-to-end: preflight + handler over stubbed db + fetch
// ─────────────────────────────────────────────────────────────────────

interface StubOpts {
  censusRows?: unknown[];
  inspectionAgg?: Record<string, unknown>;
  censusDown?: boolean;
  mirrorStale?: boolean;
  noDockets?: boolean;
}

function makeDbStub(opts: StubOpts = {}): DbQuerier {
  return {
    async query(text: string, values?: unknown[]) {
      const sql = text.replace(/\s+/g, " ");
      if (sql.includes("FROM fmcsa_ingest_runs")) {
        const at = opts.mirrorStale
          ? new Date(NOW.getTime() - 30 * 86_400_000).toISOString()
          : NOW.toISOString();
        return {
          rows: ["fmcsa_insur", "fmcsa_authhist", "fmcsa_carrier", "fmcsa_revoke", "fmcsa_boc3", "fmcsa_inshist"].map(
            (dataset) => ({ dataset, finished_at: at, max_date: "2026-07-15" }),
          ),
        };
      }
      if (sql.includes("FROM fmcsa_census_cache") && sql.startsWith("SELECT")) {
        return { rows: [] };
      }
      if (sql.includes("fmcsa_census_cache") || sql.includes("fmcsa_inspection_cache")) {
        if (sql.startsWith("SELECT")) return { rows: [] };
        return { rows: [] }; // inserts
      }
      if (sql.includes("INSERT INTO fmcsa_census_snapshots")) return { rows: [] };
      if (sql.includes("FROM fmcsa_census_snapshots")) {
        return {
          rows: [
            {
              snapshot_date: "2026-07-15",
              power_units: 12,
              total_drivers: 14,
              mcs150_date: "2026-01-10",
              mcs150_mileage: 1200000,
            },
          ],
        };
      }
      if (sql.includes("SELECT DISTINCT docket_norm")) {
        return { rows: opts.noDockets ? [] : [{ docket_norm: "MC123456" }] };
      }
      if (sql.includes("SELECT usdot_number FROM fmcsa_carrier WHERE docket_norm")) {
        return { rows: opts.noDockets ? [] : [{ usdot_number: "999999" }] };
      }
      if (sql.includes("DISTINCT ON (op_auth_type)")) {
        return {
          rows: [
            {
              op_auth_type: "Motor Carrier of Property (Except Household Goods)",
              op_auth_status: "Active",
              reason: "GRANTED",
              status_change_date: "1987-06-01",
            },
          ],
        };
      }
      if (sql.includes("MIN(status_change_date)")) {
        return { rows: [{ first_grant: "1987-06-01" }] };
      }
      if (sql.includes("FROM fmcsa_authhist")) {
        return {
          rows: [
            {
              op_auth_type: "Motor Carrier of Property (Except Household Goods)",
              op_auth_status: "Active",
              reason: "GRANTED",
              status_change_date: "1987-06-01",
            },
          ],
        };
      }
      if (sql.includes("FROM fmcsa_revoke")) return { rows: [] };
      if (sql.includes("FROM fmcsa_insur")) {
        return {
          rows: [
            {
              ins_form_code: "BMC-91X",
              ins_type_code: "1",
              max_cov_amount: "1000000",
              underl_lim_amount: "0",
              policy_no: "P1",
              effective_date: "2026-01-01",
              insurance_company_name: "ACME INSURANCE",
            },
          ],
        };
      }
      if (sql.includes("FROM fmcsa_carrier")) {
        return { rows: [{ ...REG_CARRIER, min_cov_amount: "750000" }] };
      }
      if (sql.includes("FROM fmcsa_boc3")) {
        return { rows: [{ co_name: "PROCESS AGENTS INC", city: "CHICAGO", state_code: "IL" }] };
      }
      throw new Error(`unmatched SQL in stub: ${sql} (${JSON.stringify(values)})`);
    },
  };
}

function makeFetchStub(opts: StubOpts = {}): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("az4n-8mr2")) {
      if (opts.censusDown) return new Response("upstream sad", { status: 503 });
      return new Response(JSON.stringify(opts.censusRows ?? [CENSUS_OK]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("fx4q-ay7w")) {
      return new Response(
        JSON.stringify([
          opts.inspectionAgg ?? {
            insp_count: "50",
            viol_total: "40",
            oos_total: "6",
            driver_oos: "1",
            vehicle_oos: "5",
            last_insp: "20260420",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
}

function input(body: unknown, opts: StubOpts = {}): InternalHandlerInput {
  return {
    body: buf(body),
    method: "POST",
    fetchImpl: makeFetchStub(opts),
    db: makeDbStub(opts),
  };
}

describe("preflight + handler end-to-end", () => {
  it("preflight proceeds and the handler HIREs a healthy carrier by DOT", async () => {
    const inp = input({ dot: "999999" });
    const pf = await carrierRiskVerdictPreflight(inp);
    expect(pf.proceed).toBe(true);
    const res = await carrierRiskVerdict({
      ...inp,
      preflightData: (pf as { proceed: true; data?: unknown }).data,
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body["verdict"]["decision"]).toBe("HIRE");
    expect(body["carrier"]["usdot"]).toBe("999999");
    expect(body["evidence"]["insurance"]["bipd_on_file_usd"]).toBe(1000000);
    expect(body["data_quality"]["excluded_fields"]["drug_alcohol_status"]).toBe(
      "employer-query-only",
    );
    expect(body["data_quality"]["disclaimer"]).toMatch(/not an FMCSA safety rating/);
  });

  it("resolves MC input through the mirror", async () => {
    const inp = input({ mc: "MC-123456" });
    const pf = await carrierRiskVerdictPreflight(inp);
    expect(pf.proceed).toBe(true);
    const res = await carrierRiskVerdict({
      ...inp,
      preflightData: (pf as { proceed: true; data?: unknown }).data,
    });
    expect(res.status).toBe(200);
    expect((res.body as Record<string, any>)["carrier"]["resolved_from"]).toBe("mc");
  });

  it("404s an unknown docket BEFORE settlement", async () => {
    const inp = input({ mc: "MC-777" }, { noDockets: true });
    const pf = await carrierRiskVerdictPreflight(inp);
    expect(pf.proceed).toBe(false);
    expect((pf as { status?: number }).status).toBe(404);
  });

  it("rejects ambiguous names pre-payment with a candidate list", async () => {
    const inp = input(
      { name: "SMITH TRUCKING" },
      {
        censusRows: [
          { ...CENSUS_OK, dot_number: "1", legal_name: "SMITH TRUCKING LLC" },
          { ...CENSUS_OK, dot_number: "2", legal_name: "SMITH TRUCKING INC" },
        ],
      },
    );
    const pf = await carrierRiskVerdictPreflight(inp);
    expect(pf.proceed).toBe(false);
    expect((pf as { status?: number }).status).toBe(422);
    const body = (pf as { body?: Record<string, unknown> }).body!;
    expect(body["error"]).toBe("ambiguous_carrier_name");
    expect((body["candidates"] as unknown[]).length).toBe(2);
  });

  it("fails closed (503, unpaid) when census is down with no cache", async () => {
    const inp = input({ dot: "999999" }, { censusDown: true });
    const pf = await carrierRiskVerdictPreflight(inp);
    expect(pf.proceed).toBe(false);
    expect((pf as { status?: number }).status).toBe(503);
  });

  it("fails closed when the Motus mirror is stale", async () => {
    const inp = input({ dot: "999999" }, { mirrorStale: true });
    const pf = await carrierRiskVerdictPreflight(inp);
    expect(pf.proceed).toBe(false);
    expect((pf as { status?: number }).status).toBe(503);
  });

  it("stops paid discovery-class bodies at the preflight", async () => {
    const inp = input({ dot: "string" });
    const pf = await carrierRiskVerdictPreflight(inp);
    expect(pf.proceed).toBe(false);
    expect((pf as { status?: number }).status).toBe(422);
  });
});
