import { describe, expect, it } from "vitest";
import {
  parseBrokerQuery,
  brokerAuthorityCheck,
  brokerAuthorityCheckPreflight,
  brokerAuthorityCheckValidator,
  assessBroker,
} from "../src/handlers/broker-authority-check.js";
import type {
  AuthorityStatus,
  InsuranceFiling,
  SuspensionOrder,
} from "../src/handlers/fmcsa-shared.js";
import type { DbQuerier, InternalHandlerInput } from "../src/handlers/types.js";

const NOW = new Date("2026-07-15T12:00:00Z");

function buf(v: unknown): Buffer {
  return Buffer.from(JSON.stringify(v), "utf8");
}

const BROKER_ACTIVE: AuthorityStatus = {
  op_auth_type: "Broker of Property (Except Household Goods)",
  op_auth_status: "Active",
  reason: "GRANTED",
  status_change_date: "2015-03-01",
};

const BOND_75K: InsuranceFiling = {
  form: "BMC-84",
  type: "SURETY",
  max_coverage_usd: 75_000,
  underlying_limit_usd: 0,
  policy_no: "788842",
  effective_date: "2020-10-01",
  insurer: "American Alternative Insurance Corporation",
};

const BOC3 = { co_name: "PROCESS AGENTS INC", city: "CHICAGO", state_code: "IL" };

describe("parseBrokerQuery / validator", () => {
  it("classifies discovery bodies", () => {
    expect(parseBrokerQuery(null).kind).toBe("discovery");
    expect(parseBrokerQuery(buf({})).kind).toBe("discovery");
    expect(parseBrokerQuery(buf({ mc: "string" })).kind).toBe("discovery");
    expect(brokerAuthorityCheckValidator(buf({}), "POST")).toBeNull();
  });
  it("accepts mc and dot", () => {
    expect(parseBrokerQuery(buf({ mc: "MC-133655" }))).toEqual({
      kind: "query",
      query: { kind: "mc", docketNorm: "MC133655" },
    });
    expect(parseBrokerQuery(buf({ dot: "264184" }))).toEqual({
      kind: "query",
      query: { kind: "dot", dot: "264184" },
    });
  });
  it("422s invalid values, 400s bad JSON", () => {
    expect(brokerAuthorityCheckValidator(buf({ mc: "no!digits!here!!" }), "POST")?.status).toBe(422);
    expect(brokerAuthorityCheckValidator(Buffer.from("{oops", "utf8"), "POST")?.status).toBe(400);
  });
});

describe("assessBroker", () => {
  it("ACTIVE_BONDED for active authority + 75k bond + BOC-3", () => {
    const a = assessBroker([BROKER_ACTIVE], [BROKER_ACTIVE], [], [BOND_75K], BOC3, "2015-03-01", NOW);
    expect(a.status).toBe("ACTIVE_BONDED");
    expect(a.flags).toEqual([]);
    expect(a.bond.amount_usd).toBe(75000);
    expect(a.boc3_on_file).toBe(true);
  });
  it("WATCH when no bond on file", () => {
    const a = assessBroker([BROKER_ACTIVE], [BROKER_ACTIVE], [], [], BOC3, "2015-03-01", NOW);
    expect(a.status).toBe("WATCH");
    expect(a.flags).toContain("no_bond_or_trust_on_file");
  });
  it("WATCH when bond below the MAP-21 minimum", () => {
    const a = assessBroker(
      [BROKER_ACTIVE],
      [BROKER_ACTIVE],
      [],
      [{ ...BOND_75K, max_coverage_usd: 10_000 }],
      BOC3,
      "2015-03-01",
      NOW,
    );
    expect(a.status).toBe("WATCH");
    expect(a.flags).toContain("bond_below_75k_minimum");
  });
  it("WATCH when BOC-3 is missing or authority is young", () => {
    const noBoc = assessBroker([BROKER_ACTIVE], [BROKER_ACTIVE], [], [BOND_75K], null, "2015-03-01", NOW);
    expect(noBoc.status).toBe("WATCH");
    expect(noBoc.flags).toContain("no_boc3_process_agent_on_file");
    const young: AuthorityStatus = { ...BROKER_ACTIVE, status_change_date: "2026-05-01" };
    const y = assessBroker([young], [young], [], [BOND_75K], BOC3, "2026-05-01", NOW);
    expect(y.status).toBe("WATCH");
    expect(y.flags).toContain("broker_authority_under_1_year");
  });
  it("REVOKED when broker authority is not active", () => {
    const inactive: AuthorityStatus = { ...BROKER_ACTIVE, op_auth_status: "Inactive" };
    const a = assessBroker([inactive], [inactive], [], [BOND_75K], BOC3, "2015-03-01", NOW);
    expect(a.status).toBe("REVOKED");
    expect(a.flags).toContain("broker_authority_not_active");
  });
  it("REVOKED when an involuntary suspension is in force", () => {
    const susp: SuspensionOrder = {
      op_auth_type: "Broker of Property (Except Household Goods)",
      order_type: "Operating Authority Involuntary Suspension Notice",
      serve_date: "2026-05-21",
      effective_date: "2026-06-20",
    };
    const a = assessBroker([BROKER_ACTIVE], [BROKER_ACTIVE], [susp], [BOND_75K], BOC3, "2015-03-01", NOW);
    expect(a.status).toBe("REVOKED");
    expect(a.flags).toContain("involuntary_suspension_in_force");
  });
  it("REVOKED when the docket has no broker authority at all", () => {
    const carrierOnly: AuthorityStatus = {
      op_auth_type: "Motor Carrier of Property (Except Household Goods)",
      op_auth_status: "Active",
      reason: "GRANTED",
      status_change_date: "2010-01-01",
    };
    const a = assessBroker([carrierOnly], [carrierOnly], [], [BOND_75K], BOC3, "2010-01-01", NOW);
    expect(a.status).toBe("REVOKED");
    expect(a.flags).toContain("no_broker_authority_on_docket");
    expect(a.carrier_authority_also_active).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// e2e over stubbed db (census enrichment stubbed out via fetch)
// ─────────────────────────────────────────────────────────────────────

function makeDbStub(opts: { empty?: boolean; mirrorStale?: boolean } = {}): DbQuerier {
  return {
    async query(text: string) {
      const sql = text.replace(/\s+/g, " ");
      if (sql.includes("FROM fmcsa_ingest_runs")) {
        const at = opts.mirrorStale
          ? new Date(NOW.getTime() - 30 * 86_400_000).toISOString()
          : new Date().toISOString();
        return {
          rows: ["fmcsa_insur", "fmcsa_authhist", "fmcsa_carrier"].map((dataset) => ({
            dataset,
            finished_at: at,
            max_date: "2026-07-15",
          })),
        };
      }
      if (opts.empty) return { rows: [] };
      if (sql.includes("DISTINCT ON (op_auth_type)") || sql.includes("FROM fmcsa_authhist")) {
        if (sql.includes("MIN(status_change_date)")) {
          return { rows: [{ first_grant: "2015-03-01" }] };
        }
        return { rows: [{ ...BROKER_ACTIVE }] };
      }
      if (sql.includes("MIN(status_change_date)")) {
        return { rows: [{ first_grant: "2015-03-01" }] };
      }
      if (sql.includes("FROM fmcsa_revoke")) return { rows: [] };
      if (sql.includes("SELECT usdot_number FROM fmcsa_carrier WHERE docket_norm")) {
        return { rows: [{ usdot_number: "888888" }] };
      }
      if (sql.includes("FROM fmcsa_insur")) {
        return {
          rows: [
            {
              ins_form_code: "BMC-84",
              ins_type_code: "3",
              max_cov_amount: "75000",
              underl_lim_amount: "0",
              policy_no: "788842",
              effective_date: "2020-10-01",
              insurance_company_name: "American Alternative Insurance Corporation",
            },
          ],
        };
      }
      if (sql.includes("FROM fmcsa_carrier")) {
        return {
          rows: [
            {
              docket_number: "MC888888",
              usdot_number: "888888",
              op_auth_type: "Broker of Property (Except Household Goods)",
              op_auth_status: "Active",
              legal_name: "TEST BROKERAGE LLC",
              dba_name: null,
              min_cov_amount: "0",
            },
          ],
        };
      }
      if (sql.includes("FROM fmcsa_boc3")) return { rows: [BOC3] };
      if (sql.includes("fmcsa_census_cache")) return { rows: [] };
      return { rows: [] };
    },
  };
}

function makeInput(body: unknown, opts: { empty?: boolean; mirrorStale?: boolean } = {}): InternalHandlerInput {
  const fetchStub = (async () =>
    new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  return { body: buf(body), method: "POST", db: makeDbStub(opts), fetchImpl: fetchStub };
}

describe("preflight + handler e2e", () => {
  it("returns ACTIVE_BONDED with the not-a-credit-score disclosure", async () => {
    const inp = makeInput({ mc: "MC-888888" });
    const pf = await brokerAuthorityCheckPreflight(inp);
    expect(pf.proceed).toBe(true);
    const res = await brokerAuthorityCheck({
      ...inp,
      preflightData: (pf as { proceed: true; data?: unknown }).data,
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body["verdict"]["status"]).toBe("ACTIVE_BONDED");
    expect(body["broker"]["docket"]).toBe("MC888888");
    expect(body["evidence"]["financial_responsibility"]["amount_usd"]).toBe(75000);
    expect(body["data_quality"]["not_a_credit_score"]).toMatch(/CANNOT be derived/);
  });
  it("404s an unknown docket pre-settlement", async () => {
    const pf = await brokerAuthorityCheckPreflight(makeInput({ mc: "MC-1" }, { empty: true }));
    expect(pf.proceed).toBe(false);
    expect((pf as { status?: number }).status).toBe(404);
  });
  it("fails closed on a stale mirror", async () => {
    const pf = await brokerAuthorityCheckPreflight(
      makeInput({ mc: "MC-888888" }, { mirrorStale: true }),
    );
    expect(pf.proceed).toBe(false);
    expect((pf as { status?: number }).status).toBe(503);
  });
  it("stops paid discovery-class bodies at the preflight", async () => {
    const pf = await brokerAuthorityCheckPreflight(makeInput({ mc: "example" }));
    expect(pf.proceed).toBe(false);
    expect((pf as { status?: number }).status).toBe(422);
  });
});
