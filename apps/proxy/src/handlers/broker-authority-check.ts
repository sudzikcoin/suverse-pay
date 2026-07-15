/**
 * Broker Authority Check — $0.25 verdict answering "does this freight
 * broker hold live FMCSA authority and a bond?". Buyer POSTs { mc }
 * (or { dot } as a convenience) and gets:
 *
 *   verdict      — ACTIVE_BONDED | WATCH | REVOKED + flags + summary
 *   evidence     — authority status/age/history, surety bond or trust
 *                  fund on file vs the $75k MAP-21 minimum, BOC-3
 *                  process agent, suspension orders, census identity
 *   data_quality — source freshness + the explicit not-a-credit-score
 *                  disclosure
 *
 * EXPLICITLY NOT A CREDIT SCORE. Broker payment behavior (days-to-pay)
 * lives in proprietary factoring-contributed datasets (Ansonia/Equifax)
 * and cannot be derived from public data; this product does not pretend
 * otherwise — the response says so in data_quality.not_a_credit_score.
 *
 * Runs almost entirely on the local Motus mirror (authority, insurance
 * filings, BOC-3, suspensions — fail-closed if the mirror is stale).
 * The census read is enrichment only and degrades honestly.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerPreflight,
  InternalHandlerResult,
  InternalHandlerValidator,
} from "./types.js";
import { isPlaceholderValue, type InternalHandlerInputSchema } from "./discovery.js";
import {
  SMS_DISCLAIMER,
  normalizeDocket,
  normalizeDot,
  fetchCensusByDot,
  latestAuthorityByType,
  earliestGrantDate,
  authorityHistory,
  suspensionOrders,
  insuranceOnFile,
  carrierRegistration,
  boc3OnFile,
  dotForDocket,
  docketsForDot,
  mirrorFreshness,
  mirrorIsUsable,
  type AuthorityEvent,
  type AuthorityStatus,
  type Boc3Row,
  type CachedLookup,
  type CarrierRegRow,
  type CensusRow,
  type InsuranceFiling,
  type MirrorFreshness,
  type SuspensionOrder,
} from "./fmcsa-shared.js";

// MAP-21 (2013) raised the broker financial-responsibility minimum to
// $75,000 (BMC-84 surety bond or BMC-85 trust fund).
const BROKER_BOND_REQUIRED_USD = 75_000;
const RECENT_EVENT_LOOKBACK_DAYS = 730;
const YOUNG_AUTHORITY_DAYS = 365;

const BROKER_AUTH_RE = /broker/i;
const CARRIER_AUTH_RE = /motor carrier|common|contract/i;

// ─────────────────────────────────────────────────────────────────────
// Input parsing / validation
// ─────────────────────────────────────────────────────────────────────

type BrokerQuery =
  | { kind: "mc"; docketNorm: string }
  | { kind: "dot"; dot: string };

type ParseResult =
  | { kind: "discovery" }
  | { kind: "invalid_json" }
  | { kind: "malformed" }
  | { kind: "invalid_value"; field: string; detail: string }
  | { kind: "query"; query: BrokerQuery };

export function parseBrokerQuery(body: Buffer | null): ParseResult {
  if (!body || body.length === 0 || body.toString("utf8").trim() === "") {
    return { kind: "discovery" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { kind: "invalid_json" };
  }
  if (parsed === null) return { kind: "discovery" };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "malformed" };
  }
  const o = parsed as Record<string, unknown>;
  const pick = (k: string): string | null =>
    typeof o[k] === "string" && !isPlaceholderValue(o[k] as string)
      ? (o[k] as string).trim()
      : null;
  const mcRaw = pick("mc") ?? pick("mc_number") ?? pick("docket");
  const dotRaw = pick("dot") ?? pick("usdot");
  if (mcRaw !== null) {
    const docketNorm = normalizeDocket(mcRaw);
    if (docketNorm === null) {
      return {
        kind: "invalid_value",
        field: "mc",
        detail: 'mc must look like "MC-123456" / "MC123456" / "123456" (FF/MX accepted)',
      };
    }
    return { kind: "query", query: { kind: "mc", docketNorm } };
  }
  if (dotRaw !== null) {
    const dot = normalizeDot(dotRaw);
    if (dot === null) {
      return {
        kind: "invalid_value",
        field: "dot",
        detail: "dot must be a USDOT number (1-9 digits)",
      };
    }
    return { kind: "query", query: { kind: "dot", dot } };
  }
  return { kind: "discovery" };
}

export const brokerAuthorityCheckInputSchema: InternalHandlerInputSchema = {
  method: "POST",
  content_type: "application/json",
  body: {
    type: "object",
    required: [],
    properties: {
      mc: {
        type: "string",
        description:
          'Broker MC docket number, e.g. "MC-133655" or "133655" (preferred). Provide mc or dot.',
      },
      dot: {
        type: "string",
        description:
          "USDOT number — convenience alias; resolved to the broker docket via the FMCSA registration data.",
        pattern: "^\\d{1,9}$",
      },
    },
  },
  example: { mc: "MC-133655" },
};

export const brokerAuthorityCheckValidator: InternalHandlerValidator = (
  body,
  _method,
) => {
  const p = parseBrokerQuery(body);
  switch (p.kind) {
    case "discovery":
    case "query":
      return null;
    case "invalid_json":
      return { status: 400, body: { error: "invalid_json_body" } };
    case "malformed":
      return {
        status: 422,
        body: {
          error: "broker_mc_required",
          expected: '{"mc":"MC-123456"}',
        },
      };
    case "invalid_value":
      return {
        status: 422,
        body: {
          error: `invalid_${p.field}`,
          detail: p.detail,
          expected: brokerAuthorityCheckInputSchema.example,
        },
      };
  }
};

// ─────────────────────────────────────────────────────────────────────
// Critical data
// ─────────────────────────────────────────────────────────────────────

interface CriticalData {
  kind: "broker_authority_critical";
  docketNorm: string;
  dot: string | null;
  authority: AuthorityStatus[];
  events: AuthorityEvent[];
  firstGrant: string | null;
  suspensions: SuspensionOrder[];
  filings: InsuranceFiling[];
  registration: CarrierRegRow[];
  boc3: Boc3Row | null;
  freshness: MirrorFreshness[];
  /** Enrichment only — resolves to null on any failure. */
  census: Promise<CachedLookup<CensusRow | null> | null>;
}

function isCriticalData(v: unknown): v is CriticalData {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as CriticalData).kind === "broker_authority_critical"
  );
}

type Outcome =
  | { ok: true; data: CriticalData }
  | { ok: false; result: InternalHandlerResult };

async function computeCriticalData(
  input: InternalHandlerInput,
  query: BrokerQuery,
): Promise<Outcome> {
  const db = input.db;
  if (!db) {
    return fail503("fmcsa_mirror", "no_db_wired");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = new Date();

  let freshness: MirrorFreshness[];
  try {
    freshness = await mirrorFreshness(db);
  } catch (err) {
    return fail503("fmcsa_mirror", `freshness_query_failed: ${(err as Error).message}`);
  }
  if (!mirrorIsUsable(freshness, now)) {
    return fail503(
      "fmcsa_mirror",
      "motus mirror missing or older than 8 days — refusing to sell stale registration data",
    );
  }

  try {
    let docketNorm: string;
    if (query.kind === "mc") {
      docketNorm = query.docketNorm;
    } else {
      // dot → pick the docket that carries broker authority, else first.
      const dockets = await docketsForDot(db, query.dot);
      if (dockets.length === 0) {
        return notFound(`USDOT ${query.dot} has no docket in the FMCSA Motus registration mirror`);
      }
      let withBroker: string | null = null;
      for (const d of dockets) {
        const auth = await latestAuthorityByType(db, d);
        if (auth.some((a) => BROKER_AUTH_RE.test(a.op_auth_type))) {
          withBroker = d;
          break;
        }
      }
      docketNorm = withBroker ?? dockets[0]!;
    }

    const [authority, events, firstGrant, suspensions, filings, registration, boc3, dot] =
      await Promise.all([
        latestAuthorityByType(db, docketNorm),
        authorityHistory(db, docketNorm),
        earliestGrantDate(db, docketNorm),
        suspensionOrders(db, docketNorm),
        insuranceOnFile(db, docketNorm),
        carrierRegistration(db, { docketNorm }),
        boc3OnFile(db, docketNorm),
        dotForDocket(db, docketNorm),
      ]);

    if (authority.length === 0 && registration.length === 0 && filings.length === 0) {
      return notFound(
        `docket ${docketNorm} has no record in the FMCSA Motus registration mirror`,
      );
    }

    const census: CriticalData["census"] =
      dot !== null
        ? fetchCensusByDot(db, fetchImpl, dot).catch(() => null)
        : Promise.resolve(null);

    return {
      ok: true,
      data: {
        kind: "broker_authority_critical",
        docketNorm,
        dot,
        authority,
        events,
        firstGrant,
        suspensions,
        filings,
        registration,
        boc3,
        freshness,
        census,
      },
    };
  } catch (err) {
    return fail503("fmcsa_mirror", `mirror_read_failed: ${(err as Error).message}`);
  }

  function notFound(detail: string): Outcome {
    return {
      ok: false,
      result: {
        status: 404,
        body: {
          error: "broker_not_found",
          detail,
          checked: ["fmcsa_carrier", "fmcsa_authhist", "fmcsa_insur"],
        },
      },
    };
  }
  function fail503(source: string, detail: string): Outcome {
    return {
      ok: false,
      result: {
        status: 503,
        body: { error: "critical_source_unavailable", source, detail, retryable: true },
      },
    };
  }
}

export const brokerAuthorityCheckPreflight: InternalHandlerPreflight = async (
  input,
) => {
  const p = parseBrokerQuery(input.body);
  if (p.kind !== "query") {
    return {
      proceed: false,
      status: 422,
      body: {
        error: "broker_mc_required",
        input_schema: brokerAuthorityCheckInputSchema,
      },
    };
  }
  const outcome = await computeCriticalData(input, p.query);
  if (!outcome.ok) {
    return { proceed: false, status: outcome.result.status, body: outcome.result.body };
  }
  return { proceed: true, data: outcome.data };
};

// ─────────────────────────────────────────────────────────────────────
// Verdict derivation — pure, exported for unit tests
// ─────────────────────────────────────────────────────────────────────

export type BrokerStatus = "ACTIVE_BONDED" | "WATCH" | "REVOKED";

export interface BrokerAssessment {
  status: BrokerStatus;
  flags: string[];
  broker_authority_active: boolean;
  carrier_authority_also_active: boolean;
  authority_age_days: number | null;
  bond: {
    on_file: boolean;
    kind: "SURETY" | "TRUST_FUND" | null;
    amount_usd: number | null;
    required_usd: number;
    form: string | null;
    insurer: string | null;
    effective_date: string | null;
  };
  boc3_on_file: boolean;
  revocation_events: number;
  reinstatements_24m: number;
  active_involuntary_suspension: SuspensionOrder | null;
}

function daysBetween(fromIso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(fromIso).getTime()) / 86_400_000);
}

export function assessBroker(
  authority: AuthorityStatus[],
  events: AuthorityEvent[],
  suspensions: SuspensionOrder[],
  filings: InsuranceFiling[],
  boc3: Boc3Row | null,
  firstGrant: string | null,
  now: Date,
): BrokerAssessment {
  const flags: string[] = [];
  const brokerStatuses = authority.filter((a) => BROKER_AUTH_RE.test(a.op_auth_type));
  const brokerActive = brokerStatuses.some((a) => a.op_auth_status === "Active");
  const brokerPending = brokerStatuses.some((a) => a.op_auth_status === "Pending");
  const carrierAlso = authority.some(
    (a) => CARRIER_AUTH_RE.test(a.op_auth_type) && a.op_auth_status === "Active",
  );

  // Broker authority age: earliest Active event on a broker authority type.
  const brokerGrantDates = events
    .filter(
      (e) => BROKER_AUTH_RE.test(e.op_auth_type) && e.op_auth_status === "Active",
    )
    .map((e) => e.status_change_date)
    .filter((d): d is string => d !== null)
    .sort();
  const grantAnchor = brokerGrantDates[0] ?? firstGrant;
  const ageDays = grantAnchor !== null ? daysBetween(grantAnchor, now) : null;

  const bondFiling = filings
    .filter(
      (f) =>
        (f.type === "SURETY" || f.type === "TRUST_FUND") &&
        f.max_coverage_usd !== null,
    )
    .sort((a, b) => (b.max_coverage_usd ?? 0) - (a.max_coverage_usd ?? 0))[0];

  const revocationEvents = events.filter(
    (e) =>
      BROKER_AUTH_RE.test(e.op_auth_type) &&
      (e.op_auth_status === "Inactive" || /revok/i.test(e.reason ?? "")),
  ).length;
  const reinstatements24m = events.filter(
    (e) =>
      /reinstat/i.test(e.reason ?? "") &&
      e.status_change_date !== null &&
      daysBetween(e.status_change_date, now) <= RECENT_EVENT_LOOKBACK_DAYS,
  ).length;

  const latestActiveDate = brokerStatuses
    .filter((a) => a.op_auth_status === "Active")
    .map((a) => a.status_change_date ?? "")
    .sort()
    .pop();
  const activeSuspension =
    suspensions.find((s) => {
      if (s.order_type === null || !/involuntary/i.test(s.order_type)) return false;
      const anchor = s.effective_date ?? s.serve_date;
      if (anchor === null || daysBetween(anchor, now) > RECENT_EVENT_LOOKBACK_DAYS) {
        return false;
      }
      return latestActiveDate === undefined || latestActiveDate < anchor;
    }) ?? null;

  // Status ladder.
  let status: BrokerStatus;
  if (!brokerActive) {
    status = "REVOKED";
    flags.push(
      brokerStatuses.length === 0
        ? "no_broker_authority_on_docket"
        : brokerPending
          ? "broker_authority_pending_only"
          : "broker_authority_not_active",
    );
  } else if (activeSuspension !== null) {
    status = "REVOKED";
    flags.push("involuntary_suspension_in_force");
  } else {
    status = "ACTIVE_BONDED";
    const bondAmount = bondFiling?.max_coverage_usd ?? null;
    if (bondAmount === null) {
      status = "WATCH";
      flags.push("no_bond_or_trust_on_file");
    } else if (bondAmount < BROKER_BOND_REQUIRED_USD) {
      status = "WATCH";
      flags.push("bond_below_75k_minimum");
    }
    if (boc3 === null) {
      status = "WATCH";
      flags.push("no_boc3_process_agent_on_file");
    }
    if (reinstatements24m > 0) {
      status = "WATCH";
      flags.push("recent_reinstatement_after_revocation");
    }
    if (revocationEvents > 0) {
      flags.push("revocation_events_in_history");
    }
    if (ageDays !== null && ageDays < YOUNG_AUTHORITY_DAYS) {
      status = "WATCH";
      flags.push("broker_authority_under_1_year");
    }
  }

  return {
    status,
    flags,
    broker_authority_active: brokerActive,
    carrier_authority_also_active: carrierAlso,
    authority_age_days: ageDays,
    bond: {
      on_file: bondFiling !== undefined,
      kind: bondFiling?.type === "TRUST_FUND" ? "TRUST_FUND" : bondFiling ? "SURETY" : null,
      amount_usd: bondFiling?.max_coverage_usd ?? null,
      required_usd: BROKER_BOND_REQUIRED_USD,
      form: bondFiling?.form ?? null,
      insurer: bondFiling?.insurer ?? null,
      effective_date: bondFiling?.effective_date ?? null,
    },
    boc3_on_file: boc3 !== null,
    revocation_events: revocationEvents,
    reinstatements_24m: reinstatements24m,
    active_involuntary_suspension: activeSuspension,
  };
}

export function buildBrokerSummary(
  name: string | null,
  docket: string,
  a: BrokerAssessment,
): string {
  const who = name !== null ? `${name} (${docket})` : docket;
  const statusText: Record<BrokerStatus, string> = {
    ACTIVE_BONDED: "holds active FMCSA broker authority with financial responsibility on file",
    WATCH: "holds active broker authority but with gaps worth verifying before extending credit-like exposure",
    REVOKED: "does NOT currently hold usable FMCSA broker authority",
  };
  const first = `${who} → ${a.status}: ${statusText[a.status]}.`;
  const parts: string[] = [];
  if (a.authority_age_days !== null) {
    const years = a.authority_age_days / 365;
    parts.push(
      years >= 1
        ? `broker authority ~${Math.floor(years)}y old`
        : `broker authority only ${a.authority_age_days} days old`,
    );
  }
  parts.push(
    a.bond.amount_usd !== null
      ? `$${Math.round(a.bond.amount_usd).toLocaleString("en-US")} ${a.bond.kind === "TRUST_FUND" ? "trust fund (BMC-85)" : "surety bond (BMC-84)"} on file`
      : "no bond/trust filing found",
  );
  parts.push(a.boc3_on_file ? "BOC-3 on file" : "no BOC-3 on file");
  const second = parts.join("; ") + ".";
  const third =
    a.flags.length > 0
      ? `Flags: ${a.flags.join(", ")}.`
      : "No flags raised by public FMCSA data.";
  return [first, second, third].join(" ");
}

// ─────────────────────────────────────────────────────────────────────
// The handler
// ─────────────────────────────────────────────────────────────────────

export const brokerAuthorityCheck: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  const rejected = brokerAuthorityCheckValidator(input.body, input.method);
  if (rejected) return rejected;
  const p = parseBrokerQuery(input.body);
  if (p.kind !== "query") {
    return {
      status: 422,
      body: { error: "broker_mc_required", input_schema: brokerAuthorityCheckInputSchema },
    };
  }

  let critical: CriticalData;
  if (isCriticalData(input.preflightData)) {
    critical = input.preflightData;
  } else {
    const outcome = await computeCriticalData(input, p.query);
    if (!outcome.ok) return outcome.result;
    critical = outcome.data;
  }

  const now = new Date();
  const censusLookup = await critical.census;
  const census = censusLookup?.value ?? null;

  const assessment = assessBroker(
    critical.authority,
    critical.events,
    critical.suspensions,
    critical.filings,
    critical.boc3,
    critical.firstGrant,
    now,
  );

  const legalName =
    census?.legal_name ??
    critical.registration.find((r) => r.legal_name !== null)?.legal_name ??
    null;

  const staleSources: string[] = [];
  if (censusLookup === null) staleSources.push("fmcsa_census");
  else if (censusLookup.source === "stale_cache") staleSources.push("fmcsa_census");

  return {
    status: 200,
    body: {
      broker: {
        docket: critical.docketNorm,
        usdot: critical.dot,
        legal_name: legalName,
        dba_name: census?.dba_name ?? null,
        physical_location:
          census !== null
            ? [census.phy_city, census.phy_state].filter(Boolean).join(", ") || null
            : null,
        carrier_authority_also_active: assessment.carrier_authority_also_active,
      },
      verdict: {
        status: assessment.status,
        flags: assessment.flags,
        confidence: staleSources.length > 0 ? "medium" : "high",
        summary: buildBrokerSummary(legalName, critical.docketNorm, assessment),
      },
      evidence: {
        authority: {
          statuses: critical.authority,
          broker_authority_active: assessment.broker_authority_active,
          authority_age_days: assessment.authority_age_days,
          revocation_events: assessment.revocation_events,
          reinstatements_24m: assessment.reinstatements_24m,
          history: critical.events.slice(0, 20),
          suspension_orders: critical.suspensions,
        },
        financial_responsibility: assessment.bond,
        boc3_process_agent: critical.boc3,
        filings_on_file: critical.filings,
      },
      data_quality: {
        sources: {
          fmcsa_motus_mirror: critical.freshness,
          fmcsa_census:
            censusLookup !== null
              ? { source: censusLookup.source, fetched_at: censusLookup.fetchedAt.toISOString() }
              : { source: "unavailable" },
        },
        stale_sources: staleSources,
        not_a_credit_score:
          "This is an authority/bond/registration check only. Broker payment " +
          "behavior (days-to-pay, credit) lives in proprietary factoring-" +
          "contributed datasets and CANNOT be derived from public FMCSA data; " +
          "no such score is included or implied.",
        computed_at: now.toISOString(),
        disclaimer: SMS_DISCLAIMER,
      },
    },
  };
};
