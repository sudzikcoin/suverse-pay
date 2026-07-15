/**
 * Carrier Risk Verdict — ONE aggregated $0.75 verdict answering "can I
 * put a load on this trucking company?". Buyer POSTs { dot } or { mc }
 * (or { name } — resolved to a DOT, ambiguity rejected pre-payment with
 * a free candidate list) and gets:
 *
 *   verdict      — HIRE | VERIFY | AVOID + 0-100 score + component
 *                  scores + 2-3 sentence summary + confidence
 *   evidence     — authority, insurance, safety, fraud-signal and
 *                  BOC-3 layers with the raw values behind each call
 *   data_quality — per-source freshness, stale sources, the FMCSA SMS
 *                  disclaimer, and honest field-level exclusions
 *
 * Sources (all public domain FMCSA data):
 *   1. Postgres mirror of the Motus datasets (authority, insurance,
 *      suspensions, BOC-3, registration) — refreshed daily, fail-closed
 *      if older than 8 days.
 *   2. Census az4n-8mr2 (identity + MCS-150 fraud fields) — live
 *      per-DOT Socrata with 24h cache, stale-if-error to 7d. CRITICAL:
 *      live failure with no cache fails the call pre-settlement.
 *   3. Inspections fx4q-ay7w (24-month roadside summary) — live
 *      per-DOT Socrata, same caching. DEGRADABLE: failure nulls the
 *      safety component and lowers confidence, never fails the call.
 *
 * Honesty constraints baked in:
 *   - drug_alcohol_status is ALWAYS "employer-query-only" — the FMCSA
 *     Clearinghouse has no third-party API and we will not fake it.
 *   - No "CSA scores": FAST Act §5223 masks property-carrier BASIC
 *     percentiles; we expose raw inspection counts + our own score.
 *   - Every response carries the SMS disclaimer.
 *   - Community incident reports (Carrier411-style) are named as an
 *     exclusion — that signal class cannot be built from public data.
 */
import type {
  DbQuerier,
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
  searchCensusByName,
  snapshotCensus,
  fetchInspectionSummary,
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
  type AuthorityStatus,
  type AuthorityEvent,
  type CachedLookup,
  type CarrierRegRow,
  type CensusRow,
  type CensusSnapshot,
  type InspectionSummary,
  type InsuranceFiling,
  type MirrorFreshness,
  type NameCandidate,
  type SuspensionOrder,
  type Boc3Row,
} from "./fmcsa-shared.js";

// ─────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────

// National average roadside OOS rates (FMCSA roadside intervention
// aggregates, approximate; used only as comparison anchors and named
// as approximations in the evidence layer).
const NATIONAL_VEHICLE_OOS_RATE = 0.207;
const NATIONAL_DRIVER_OOS_RATE = 0.055;

const HIRE_MIN_SCORE = 75;
const VERIFY_MIN_SCORE = 50;

// Component weights (renormalized when safety is null).
const WEIGHTS = { authority: 0.3, insurance: 0.25, safety: 0.25, fraud: 0.2 };

const NEW_AUTHORITY_DAYS = 180;
const YOUNG_AUTHORITY_DAYS = 365;
const SELF_INSURED_MIN_AUTHORITY_YEARS = 10;
const MCS150_STALE_DAYS = 2 * 365 + 30; // biennial update + grace
const DEFAULT_BIPD_REQUIRED_USD = 750_000;
const FLEET_JUMP_FACTOR = 3;
const FLEET_JUMP_MIN_DELTA = 5;
const INSTANT_FLEET_MIN_UNITS = 20;
const SUSPENSION_LOOKBACK_DAYS = 730;

// ─────────────────────────────────────────────────────────────────────
// Input parsing / validation
// ─────────────────────────────────────────────────────────────────────

export type CarrierQuery =
  | { kind: "dot"; dot: string }
  | { kind: "mc"; docketNorm: string; raw: string }
  | { kind: "name"; name: string };

type ParseResult =
  | { kind: "discovery" }
  | { kind: "invalid_json" }
  | { kind: "malformed" }
  | { kind: "invalid_value"; field: string; detail: string }
  | { kind: "query"; query: CarrierQuery };

export function parseCarrierQuery(body: Buffer | null): ParseResult {
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
  const dotRaw = pick("dot") ?? pick("usdot") ?? pick("dot_number");
  const mcRaw = pick("mc") ?? pick("mc_number") ?? pick("docket");
  const nameRaw = pick("name") ?? pick("carrier_name");
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
  if (mcRaw !== null) {
    const docketNorm = normalizeDocket(mcRaw);
    if (docketNorm === null) {
      return {
        kind: "invalid_value",
        field: "mc",
        detail: 'mc must look like "MC-123456" / "MC123456" / "123456" (FF/MX accepted)',
      };
    }
    return { kind: "query", query: { kind: "mc", docketNorm, raw: mcRaw } };
  }
  if (nameRaw !== null) {
    if (nameRaw.length < 3) {
      return {
        kind: "invalid_value",
        field: "name",
        detail: "name must be at least 3 characters",
      };
    }
    return { kind: "query", query: { kind: "name", name: nameRaw } };
  }
  return { kind: "discovery" };
}

export const carrierRiskVerdictInputSchema: InternalHandlerInputSchema = {
  method: "POST",
  content_type: "application/json",
  body: {
    type: "object",
    required: [],
    properties: {
      dot: {
        type: "string",
        description:
          "USDOT number of the carrier (preferred). Provide exactly one of dot | mc | name.",
        pattern: "^\\d{1,9}$",
      },
      mc: {
        type: "string",
        description:
          'MC docket number, e.g. "MC-133655" or "133655". Provide exactly one of dot | mc | name.',
      },
      name: {
        type: "string",
        description:
          "Carrier legal or DBA name. Ambiguous names are rejected BEFORE payment with a free candidate list (no charge).",
      },
    },
  },
  example: { dot: "264184" },
};

export const carrierRiskVerdictValidator: InternalHandlerValidator = (
  body,
  _method,
) => {
  const p = parseCarrierQuery(body);
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
          error: "carrier_identifier_required",
          expected: '{"dot":"<usdot>"} or {"mc":"MC-123456"} or {"name":"<carrier name>"}',
        },
      };
    case "invalid_value":
      return {
        status: 422,
        body: {
          error: `invalid_${p.field}`,
          detail: p.detail,
          expected: carrierRiskVerdictInputSchema.example,
        },
      };
  }
};

// ─────────────────────────────────────────────────────────────────────
// Critical data (preflight-computed, threaded into the handler)
// ─────────────────────────────────────────────────────────────────────

interface CriticalData {
  kind: "carrier_risk_critical";
  dot: string;
  dockets: string[];
  resolvedFrom: "dot" | "mc" | "name";
  census: CachedLookup<CensusRow | null>;
  snapshots: CensusSnapshot[];
  authority: AuthorityStatus[];
  authorityEvents: AuthorityEvent[];
  firstGrant: string | null;
  suspensions: SuspensionOrder[];
  insurance: InsuranceFiling[];
  registration: CarrierRegRow[];
  boc3: Boc3Row | null;
  freshness: MirrorFreshness[];
  /** Started in preflight, awaited post-settlement; never rejects. */
  inspections: Promise<
    | { ok: true; lookup: CachedLookup<InspectionSummary> }
    | { ok: false; error: string }
  >;
}

function isCriticalData(v: unknown): v is CriticalData {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as CriticalData).kind === "carrier_risk_critical"
  );
}

type ResolveOutcome =
  | { ok: true; data: CriticalData }
  | { ok: false; result: InternalHandlerResult };

async function computeCriticalData(
  input: InternalHandlerInput,
  query: CarrierQuery,
): Promise<ResolveOutcome> {
  const db = input.db;
  if (!db) {
    return {
      ok: false,
      result: {
        status: 503,
        body: { error: "critical_source_unavailable", source: "fmcsa_mirror", detail: "no_db_wired", retryable: true },
      },
    };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = new Date();

  // 1. Mirror freshness gate (fail-closed).
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

  // 2. Resolve the identifier to a DOT (+ dockets).
  let dot: string | null = null;
  let dockets: string[] = [];
  let resolvedFrom: CriticalData["resolvedFrom"];
  try {
    if (query.kind === "dot") {
      resolvedFrom = "dot";
      dot = query.dot;
      dockets = await docketsForDot(db, dot);
    } else if (query.kind === "mc") {
      resolvedFrom = "mc";
      dot = await dotForDocket(db, query.docketNorm);
      dockets = [query.docketNorm];
      if (dot === null) {
        return {
          ok: false,
          result: {
            status: 404,
            body: {
              error: "carrier_not_found",
              detail: `docket ${query.docketNorm} has no record in the FMCSA Motus registration mirror`,
              checked: ["fmcsa_carrier", "fmcsa_authhist", "fmcsa_insur"],
            },
          },
        };
      }
    } else {
      resolvedFrom = "name";
      let candidates: NameCandidate[];
      try {
        candidates = await searchCensusByName(fetchImpl, query.name);
      } catch (err) {
        return fail503("census_name_search", (err as Error).message);
      }
      if (candidates.length === 0) {
        return {
          ok: false,
          result: {
            status: 404,
            body: {
              error: "carrier_not_found",
              detail: `no census carrier matches "${query.name}"`,
            },
          },
        };
      }
      if (candidates.length > 1) {
        return {
          ok: false,
          result: {
            status: 422,
            body: {
              error: "ambiguous_carrier_name",
              detail:
                "multiple carriers match — re-query with the dot (or mc) of the intended one; this disambiguation is free (no payment was settled)",
              candidates,
            },
          },
        };
      }
      dot = candidates[0]!.dot_number;
      dockets = await docketsForDot(db, dot);
    }
  } catch (err) {
    return fail503("fmcsa_mirror", `resolution_failed: ${(err as Error).message}`);
  }

  // 3. Census (CRITICAL — identity + fraud fields).
  let census: CachedLookup<CensusRow | null>;
  try {
    census = await fetchCensusByDot(db, fetchImpl, dot);
  } catch (err) {
    return fail503("fmcsa_census", (err as Error).message);
  }
  if (census.value === null && dockets.length === 0) {
    return {
      ok: false,
      result: {
        status: 404,
        body: {
          error: "carrier_not_found",
          detail: `USDOT ${dot} is in neither the FMCSA census nor the Motus registration data`,
        },
      },
    };
  }

  // 4. Mirror reads (local, fast) — across ALL the carrier's dockets.
  try {
    const per = await Promise.all(
      dockets.map(async (d) => ({
        authority: await latestAuthorityByType(db, d),
        events: await authorityHistory(db, d),
        firstGrant: await earliestGrantDate(db, d),
        suspensions: await suspensionOrders(db, d),
        insurance: await insuranceOnFile(db, d),
        registration: await carrierRegistration(db, { docketNorm: d }),
        boc3: await boc3OnFile(db, d),
      })),
    );
    const flat = <T>(sel: (x: (typeof per)[number]) => T[]): T[] =>
      per.flatMap((x) => sel(x));
    const firstGrants = per.map((p) => p.firstGrant).filter((g): g is string => g !== null);
    const snapshots =
      census.value !== null ? await snapshotCensus(db, dot, census.value) : [];

    // Inspections kicked off WITHOUT await — settlement latency absorbs it.
    const inspections = fetchInspectionSummary(db, fetchImpl, dot, now)
      .then((lookup) => ({ ok: true as const, lookup }))
      .catch((err: Error) => ({ ok: false as const, error: err.message }));

    return {
      ok: true,
      data: {
        kind: "carrier_risk_critical",
        dot,
        dockets,
        resolvedFrom,
        census,
        snapshots,
        authority: flat((x) => x.authority),
        authorityEvents: flat((x) => x.events),
        firstGrant: firstGrants.length > 0 ? firstGrants.sort()[0]! : null,
        suspensions: flat((x) => x.suspensions),
        insurance: flat((x) => x.insurance),
        registration: flat((x) => x.registration),
        boc3: per.map((p) => p.boc3).find((b) => b !== null) ?? null,
        freshness,
        inspections,
      },
    };
  } catch (err) {
    return fail503("fmcsa_mirror", `mirror_read_failed: ${(err as Error).message}`);
  }

  function fail503(source: string, detail: string): ResolveOutcome {
    return {
      ok: false,
      result: {
        status: 503,
        body: { error: "critical_source_unavailable", source, detail, retryable: true },
      },
    };
  }
}

export const carrierRiskVerdictPreflight: InternalHandlerPreflight = async (
  input,
) => {
  const p = parseCarrierQuery(input.body);
  if (p.kind !== "query") {
    // Discovery-class bodies pass the validator so crawlers can read
    // the 402; a buyer who PAYS with such a body stops here — unpaid.
    return {
      proceed: false,
      status: 422,
      body: {
        error: "carrier_identifier_required",
        input_schema: carrierRiskVerdictInputSchema,
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

export type Decision = "HIRE" | "VERIFY" | "AVOID";

const CARRIER_AUTH_RE = /motor carrier|common|contract/i;
const BROKER_AUTH_RE = /broker/i;

export interface AuthorityAssessment {
  score: number;
  active_carrier_authority: boolean;
  broker_only: boolean;
  statuses: AuthorityStatus[];
  first_granted: string | null;
  authority_age_days: number | null;
  revocation_events: number;
  reinstatements_24m: number;
  active_involuntary_suspension: SuspensionOrder | null;
  flags: string[];
}

function daysBetween(fromIso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(fromIso).getTime()) / 86_400_000);
}

export function assessAuthority(
  authority: AuthorityStatus[],
  events: AuthorityEvent[],
  suspensions: SuspensionOrder[],
  firstGrant: string | null,
  now: Date,
): AuthorityAssessment {
  const flags: string[] = [];
  const carrierStatuses = authority.filter((a) => CARRIER_AUTH_RE.test(a.op_auth_type));
  const brokerStatuses = authority.filter((a) => BROKER_AUTH_RE.test(a.op_auth_type));
  const activeCarrier = carrierStatuses.some((a) => a.op_auth_status === "Active");
  const pendingCarrier = carrierStatuses.some((a) => a.op_auth_status === "Pending");
  const brokerOnly =
    !activeCarrier &&
    carrierStatuses.length === 0 &&
    brokerStatuses.some((a) => a.op_auth_status === "Active");

  const ageDays = firstGrant !== null ? daysBetween(firstGrant, now) : null;

  const revocationEvents = events.filter(
    (e) => e.op_auth_status === "Inactive" || /revok/i.test(e.reason ?? ""),
  ).length;
  const reinstatements24m = events.filter(
    (e) =>
      /reinstat/i.test(e.reason ?? "") &&
      e.status_change_date !== null &&
      daysBetween(e.status_change_date, now) <= SUSPENSION_LOOKBACK_DAYS,
  ).length;

  // An involuntary suspension notice is "in force" when it was served in
  // the lookback window and no LATER authority event returned the docket
  // to Active.
  const latestActiveDate = authority
    .filter((a) => a.op_auth_status === "Active")
    .map((a) => a.status_change_date ?? "")
    .sort()
    .pop();
  const activeSuspension =
    suspensions.find((s) => {
      if (s.order_type === null || !/involuntary/i.test(s.order_type)) return false;
      const anchor = s.effective_date ?? s.serve_date;
      if (anchor === null || daysBetween(anchor, now) > SUSPENSION_LOOKBACK_DAYS) {
        return false;
      }
      return latestActiveDate === undefined || latestActiveDate < anchor;
    }) ?? null;

  let score: number;
  if (activeCarrier) score = 100;
  else if (pendingCarrier) {
    score = 35;
    flags.push("authority_pending_only");
  } else if (brokerOnly) {
    score = 20;
    flags.push("broker_only_authority_carrier_check");
  } else {
    score = 0;
    flags.push("no_active_carrier_authority");
  }
  if (activeSuspension !== null) {
    score = Math.max(0, score - 40);
    flags.push("involuntary_suspension_in_force");
  }
  if (reinstatements24m > 0) {
    score = Math.max(0, score - 25);
    flags.push("recent_reinstatement_after_revocation");
  }
  if (ageDays !== null && ageDays < NEW_AUTHORITY_DAYS) {
    score = Math.max(0, score - 20);
    flags.push("authority_under_6_months");
  } else if (ageDays !== null && ageDays < YOUNG_AUTHORITY_DAYS) {
    score = Math.max(0, score - 10);
    flags.push("authority_under_1_year");
  }

  return {
    score,
    active_carrier_authority: activeCarrier,
    broker_only: brokerOnly,
    statuses: authority,
    first_granted: firstGrant,
    authority_age_days: ageDays,
    revocation_events: revocationEvents,
    reinstatements_24m: reinstatements24m,
    active_involuntary_suspension: activeSuspension,
    flags,
  };
}

export interface InsuranceAssessment {
  score: number;
  bipd_on_file_usd: number | null;
  bipd_required_usd: number | null;
  bipd_insurer: string | null;
  bipd_effective_date: string | null;
  cargo_required: boolean;
  cargo_on_file: boolean;
  possible_self_insured: boolean;
  filings: InsuranceFiling[];
  flags: string[];
}

export function assessInsurance(
  filings: InsuranceFiling[],
  registration: CarrierRegRow[],
  auth: AuthorityAssessment,
): InsuranceAssessment {
  const flags: string[] = [];
  const bipd = filings
    .filter((f) => f.type === "BIPD" && f.max_coverage_usd !== null)
    .sort((a, b) => (b.max_coverage_usd ?? 0) - (a.max_coverage_usd ?? 0))[0];
  const bipdOnFile = bipd?.max_coverage_usd ?? null;

  const carrierRows = registration.filter((r) =>
    CARRIER_AUTH_RE.test(r.op_auth_type ?? ""),
  );
  const requiredRaw = Math.max(0, ...carrierRows.map((r) => r.min_cov_amount ?? 0));
  const bipdRequired =
    requiredRaw > 0
      ? requiredRaw
      : auth.active_carrier_authority
        ? DEFAULT_BIPD_REQUIRED_USD
        : null;

  const cargoRequired = carrierRows.some((r) => r.cargo_req === "Y");
  const cargoOnFile =
    filings.some((f) => f.type === "CARGO") ||
    carrierRows.some((r) => r.cargo_file === "Y");

  const authorityYears = (auth.authority_age_days ?? 0) / 365;
  let possibleSelfInsured = false;

  let score: number;
  if (bipdOnFile !== null && bipdRequired !== null && bipdOnFile >= bipdRequired) {
    score = 100;
  } else if (bipdOnFile !== null) {
    score = 35;
    flags.push("bipd_below_required_minimum");
  } else if (auth.active_carrier_authority && authorityYears >= SELF_INSURED_MIN_AUTHORITY_YEARS) {
    score = 40;
    possibleSelfInsured = true;
    flags.push("no_bipd_filing_possible_self_insured");
  } else if (auth.active_carrier_authority) {
    score = 0;
    flags.push("no_bipd_on_file");
  } else {
    // No carrier authority — insurance requirement doesn't attach.
    score = bipdOnFile !== null ? 100 : 50;
  }
  if (cargoRequired && !cargoOnFile) {
    score = Math.max(0, score - 20);
    flags.push("cargo_insurance_required_but_not_on_file");
  }

  return {
    score,
    bipd_on_file_usd: bipdOnFile,
    bipd_required_usd: bipdRequired,
    bipd_insurer: bipd?.insurer ?? null,
    bipd_effective_date: bipd?.effective_date ?? null,
    cargo_required: cargoRequired,
    cargo_on_file: cargoOnFile,
    possible_self_insured: possibleSelfInsured,
    filings,
    flags,
  };
}

export interface SafetyAssessment {
  score: number | null;
  summary: InspectionSummary | null;
  national_vehicle_oos_rate: number;
  national_driver_oos_rate: number;
  source: "live" | "cache" | "stale_cache" | "unavailable";
  flags: string[];
}

export function assessSafety(
  lookup: CachedLookup<InspectionSummary> | null,
  census: CensusRow | null,
  auth: AuthorityAssessment,
): SafetyAssessment {
  const flags: string[] = [];
  if (lookup === null) {
    flags.push("inspection_data_unavailable");
    return {
      score: null,
      summary: null,
      national_vehicle_oos_rate: NATIONAL_VEHICLE_OOS_RATE,
      national_driver_oos_rate: NATIONAL_DRIVER_OOS_RATE,
      source: "unavailable",
      flags,
    };
  }
  const s = lookup.value;
  let score: number;
  if (s.inspection_count === 0) {
    const bigFleet = (census?.power_units ?? 0) > 10;
    const oldAuthority = (auth.authority_age_days ?? 0) > 2 * 365;
    score = bigFleet && oldAuthority ? 50 : 60;
    flags.push("no_roadside_inspections_in_24_months");
  } else {
    score = 100;
    if (s.vehicle_oos_rate !== null) {
      if (s.vehicle_oos_rate > NATIONAL_VEHICLE_OOS_RATE * 1.5) {
        score -= 30;
        flags.push("vehicle_oos_rate_over_1_5x_national");
      } else if (s.vehicle_oos_rate > NATIONAL_VEHICLE_OOS_RATE) {
        score -= 10;
        flags.push("vehicle_oos_rate_above_national");
      }
    }
    if (s.driver_oos_rate !== null) {
      if (s.driver_oos_rate > NATIONAL_DRIVER_OOS_RATE * 1.5) {
        score -= 30;
        flags.push("driver_oos_rate_over_1_5x_national");
      } else if (s.driver_oos_rate > NATIONAL_DRIVER_OOS_RATE) {
        score -= 10;
        flags.push("driver_oos_rate_above_national");
      }
    }
    if (s.inspection_count > 0 && s.violation_total / s.inspection_count > 3) {
      score -= 15;
      flags.push("high_violations_per_inspection");
    }
    score = Math.max(0, score);
  }
  return {
    score,
    summary: s,
    national_vehicle_oos_rate: NATIONAL_VEHICLE_OOS_RATE,
    national_driver_oos_rate: NATIONAL_DRIVER_OOS_RATE,
    source: lookup.source,
    flags,
  };
}

export interface FraudAssessment {
  score: number;
  mcs150_date: string | null;
  mcs150_age_days: number | null;
  mcs150_stale: boolean;
  power_units: number | null;
  total_drivers: number | null;
  mcs150_mileage: number | null;
  mileage_per_power_unit: number | null;
  fleet_jump: { from: number; to: number; window_days: number } | null;
  snapshot_history_days: number;
  undeliverable_address: boolean;
  census_status: string | null;
  flags: string[];
}

export function assessFraudSignals(
  census: CensusRow | null,
  snapshots: CensusSnapshot[],
  registration: CarrierRegRow[],
  auth: AuthorityAssessment,
  now: Date,
): FraudAssessment {
  const flags: string[] = [];
  let score = 100;

  const mcs150Date = census?.mcs150_date ?? null;
  let mcs150AgeDays: number | null = null;
  let mcs150Stale = false;
  if (mcs150Date !== null) {
    const d = new Date(mcs150Date);
    if (!Number.isNaN(d.getTime())) {
      mcs150AgeDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
      mcs150Stale = mcs150AgeDays > MCS150_STALE_DAYS;
    }
  } else if (census !== null) {
    mcs150Stale = true;
    flags.push("mcs150_date_missing");
  }
  if (mcs150Stale) {
    score -= 30;
    flags.push("mcs150_filing_stale_over_2_years");
  }

  // Fleet jump from OUR accumulated snapshots (honest: depth disclosed).
  let fleetJump: FraudAssessment["fleet_jump"] = null;
  const withUnits = snapshots.filter((s) => s.power_units !== null && s.power_units > 0);
  if (withUnits.length >= 2) {
    const first = withUnits[0]!;
    const last = withUnits[withUnits.length - 1]!;
    const from = first.power_units!;
    const to = last.power_units!;
    if (to >= from * FLEET_JUMP_FACTOR && to - from >= FLEET_JUMP_MIN_DELTA) {
      fleetJump = {
        from,
        to,
        window_days: daysBetween(first.snapshot_date, new Date(last.snapshot_date)),
      };
      score -= mcs150Stale ? 40 : 25;
      flags.push("fleet_size_jump_detected");
    }
  }
  const historyDays =
    withUnits.length >= 2
      ? daysBetween(withUnits[0]!.snapshot_date, now)
      : 0;

  // Census undeliv_phy: 'U' = physical address mail returned undeliverable
  // (327k of 4.47M rows; blank = fine). The Motus Carrier mail flags are
  // 'Y' for 99% of rows — semantically useless, deliberately NOT used.
  const undeliverable = census?.undeliv_phy === "U";
  if (undeliverable) {
    score -= 30;
    flags.push("undeliverable_address_on_file");
  }

  const powerUnits = census?.power_units ?? null;
  const mileage = census?.mcs150_mileage ?? null;
  let mileagePerUnit: number | null = null;
  if (powerUnits !== null && powerUnits > 0 && mileage !== null && mileage > 0) {
    mileagePerUnit = Math.round(mileage / powerUnits);
    if (mileagePerUnit < 10_000 || mileagePerUnit > 250_000) {
      score -= 15;
      flags.push("mcs150_mileage_per_truck_anomalous");
    }
  }

  if (
    auth.authority_age_days !== null &&
    auth.authority_age_days < NEW_AUTHORITY_DAYS &&
    (powerUnits ?? 0) >= INSTANT_FLEET_MIN_UNITS
  ) {
    score -= 25;
    flags.push("new_authority_with_large_fleet");
  }

  const censusStatus = census?.status_code ?? null;
  if (census !== null && censusStatus !== null && censusStatus !== "A") {
    score -= 40;
    flags.push("census_record_inactive");
  }
  if (census === null) {
    score -= 20;
    flags.push("no_census_record_for_dot");
  }

  return {
    score: Math.max(0, score),
    mcs150_date: mcs150Date,
    mcs150_age_days: mcs150AgeDays,
    mcs150_stale: mcs150Stale,
    power_units: powerUnits,
    total_drivers: census?.total_drivers ?? null,
    mcs150_mileage: mileage,
    mileage_per_power_unit: mileagePerUnit,
    fleet_jump: fleetJump,
    snapshot_history_days: historyDays,
    undeliverable_address: undeliverable,
    census_status: censusStatus,
    flags,
  };
}

export interface VerdictComputation {
  decision: Decision;
  score: number;
  hard_fail: string | null;
  component_scores: {
    authority: number;
    insurance: number;
    safety: number | null;
    fraud_signals: number;
  };
}

export function computeVerdict(
  auth: AuthorityAssessment,
  ins: InsuranceAssessment,
  safety: SafetyAssessment,
  fraud: FraudAssessment,
): VerdictComputation {
  const components = {
    authority: auth.score,
    insurance: ins.score,
    safety: safety.score,
    fraud_signals: fraud.score,
  };

  let hardFail: string | null = null;
  if (!auth.active_carrier_authority) {
    hardFail = auth.broker_only
      ? "no_carrier_authority_docket_is_broker_only"
      : "no_active_carrier_authority";
  } else if (auth.active_involuntary_suspension !== null) {
    hardFail = "involuntary_suspension_in_force";
  } else if (
    ins.bipd_on_file_usd === null &&
    !ins.possible_self_insured
  ) {
    hardFail = "required_bipd_insurance_not_on_file";
  }

  const entries: Array<[keyof typeof WEIGHTS, number]> = [
    ["authority", auth.score],
    ["insurance", ins.score],
    ["fraud", fraud.score],
  ];
  if (safety.score !== null) entries.push(["safety", safety.score]);
  const totalWeight = entries.reduce((acc, [k]) => acc + WEIGHTS[k], 0);
  const score = Math.round(
    entries.reduce((acc, [k, v]) => acc + v * WEIGHTS[k], 0) / totalWeight,
  );

  let decision: Decision;
  if (hardFail !== null) decision = "AVOID";
  else if (score >= HIRE_MIN_SCORE) decision = "HIRE";
  else if (score >= VERIFY_MIN_SCORE) decision = "VERIFY";
  else decision = "AVOID";

  return { decision, score, hard_fail: hardFail, component_scores: components };
}

export function buildCarrierSummary(
  name: string | null,
  dot: string,
  v: VerdictComputation,
  auth: AuthorityAssessment,
  ins: InsuranceAssessment,
  safety: SafetyAssessment,
  fraud: FraudAssessment,
): string {
  const who = name !== null ? `${name} (USDOT ${dot})` : `USDOT ${dot}`;
  const first = `${who} scores ${v.score}/100 → ${v.decision}.`;
  let second: string;
  if (v.hard_fail !== null) {
    const reasonText: Record<string, string> = {
      no_active_carrier_authority:
        "It has no active motor-carrier operating authority on file with FMCSA.",
      no_carrier_authority_docket_is_broker_only:
        "This docket holds broker authority only — it is not authorized to haul freight itself.",
      involuntary_suspension_in_force:
        "FMCSA served an involuntary suspension of its operating authority that does not appear to have been lifted.",
      required_bipd_insurance_not_on_file:
        "Required BIPD liability insurance is not on file with FMCSA.",
    };
    second = reasonText[v.hard_fail] ?? `Hard fail: ${v.hard_fail}.`;
  } else {
    const parts: string[] = [];
    parts.push(
      auth.authority_age_days !== null
        ? `Authority active for ${Math.floor(auth.authority_age_days / 365)}+ years`
        : "Authority active",
    );
    if (ins.bipd_on_file_usd !== null) {
      parts.push(`$${Math.round(ins.bipd_on_file_usd).toLocaleString("en-US")} BIPD on file`);
    } else if (ins.possible_self_insured) {
      parts.push("no BIPD filing (possible FMCSA-approved self-insurance — verify)");
    }
    if (safety.summary !== null) {
      parts.push(
        safety.summary.inspection_count > 0
          ? `${safety.summary.inspection_count} roadside inspections in 24 months`
          : "no roadside inspections in 24 months",
      );
    }
    second = parts.join("; ") + ".";
  }
  const cautionFlags = [...auth.flags, ...ins.flags, ...safety.flags, ...fraud.flags];
  const third =
    cautionFlags.length > 0
      ? `Caution flags: ${cautionFlags.slice(0, 6).join(", ")}.`
      : "No caution flags raised by public FMCSA data.";
  return [first, second, third].join(" ");
}

// ─────────────────────────────────────────────────────────────────────
// The handler
// ─────────────────────────────────────────────────────────────────────

export const carrierRiskVerdict: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  const rejected = carrierRiskVerdictValidator(input.body, input.method);
  if (rejected) return rejected;
  const p = parseCarrierQuery(input.body);
  if (p.kind !== "query") {
    return {
      status: 422,
      body: {
        error: "carrier_identifier_required",
        input_schema: carrierRiskVerdictInputSchema,
      },
    };
  }

  let critical: CriticalData;
  if (isCriticalData(input.preflightData)) {
    critical = input.preflightData;
  } else {
    // Direct/test invocation only — the paid path always has preflightData.
    const outcome = await computeCriticalData(input, p.query);
    if (!outcome.ok) return outcome.result;
    critical = outcome.data;
  }

  const now = new Date();
  const inspectionsResult = await critical.inspections;
  const inspectionLookup = inspectionsResult.ok ? inspectionsResult.lookup : null;

  const auth = assessAuthority(
    critical.authority,
    critical.authorityEvents,
    critical.suspensions,
    critical.firstGrant,
    now,
  );
  const ins = assessInsurance(critical.insurance, critical.registration, auth);
  const safety = assessSafety(inspectionLookup, critical.census.value, auth);
  const fraud = assessFraudSignals(
    critical.census.value,
    critical.snapshots,
    critical.registration,
    auth,
    now,
  );
  const verdict = computeVerdict(auth, ins, safety, fraud);

  const census = critical.census.value;
  const legalName =
    census?.legal_name ??
    critical.registration.find((r) => r.legal_name !== null)?.legal_name ??
    null;

  const staleSources: string[] = [];
  if (critical.census.source === "stale_cache") staleSources.push("fmcsa_census");
  if (safety.source === "stale_cache" || safety.source === "unavailable") {
    staleSources.push("fmcsa_inspections");
  }
  const confidence: "low" | "medium" | "high" =
    safety.source === "unavailable"
      ? "low"
      : staleSources.length > 0
        ? "medium"
        : "high";

  return {
    status: 200,
    body: {
      carrier: {
        usdot: critical.dot,
        dockets: critical.dockets,
        legal_name: legalName,
        dba_name: census?.dba_name ?? null,
        physical_location:
          census !== null
            ? [census.phy_city, census.phy_state].filter(Boolean).join(", ") || null
            : null,
        resolved_from: critical.resolvedFrom,
      },
      verdict: {
        decision: verdict.decision,
        score: verdict.score,
        component_scores: verdict.component_scores,
        hard_fail: verdict.hard_fail,
        confidence,
        summary: buildCarrierSummary(
          legalName,
          critical.dot,
          verdict,
          auth,
          ins,
          safety,
          fraud,
        ),
      },
      evidence: {
        authority: {
          statuses: auth.statuses,
          first_granted: auth.first_granted,
          authority_age_days: auth.authority_age_days,
          revocation_events: auth.revocation_events,
          reinstatements_24m: auth.reinstatements_24m,
          suspension_orders: critical.suspensions,
          flags: auth.flags,
        },
        insurance: {
          bipd_on_file_usd: ins.bipd_on_file_usd,
          bipd_required_usd: ins.bipd_required_usd,
          bipd_insurer: ins.bipd_insurer,
          bipd_effective_date: ins.bipd_effective_date,
          cargo_required: ins.cargo_required,
          cargo_on_file: ins.cargo_on_file,
          possible_self_insured: ins.possible_self_insured,
          filings_on_file: ins.filings,
          flags: ins.flags,
        },
        safety: {
          window_months: safety.summary?.window_months ?? 24,
          inspections: safety.summary,
          national_average_comparison: {
            vehicle_oos_rate_national_approx: safety.national_vehicle_oos_rate,
            driver_oos_rate_national_approx: safety.national_driver_oos_rate,
          },
          note:
            "Raw roadside inspection counts. FAST Act masks property-carrier " +
            "BASIC percentiles from public data; this is NOT a CSA/SMS score.",
          flags: safety.flags,
        },
        fraud_signals: {
          mcs150_date: fraud.mcs150_date,
          mcs150_age_days: fraud.mcs150_age_days,
          mcs150_stale: fraud.mcs150_stale,
          power_units: fraud.power_units,
          total_drivers: fraud.total_drivers,
          mcs150_mileage: fraud.mcs150_mileage,
          mileage_per_power_unit: fraud.mileage_per_power_unit,
          fleet_jump: fraud.fleet_jump,
          snapshot_history_days: fraud.snapshot_history_days,
          undeliverable_address: fraud.undeliverable_address,
          census_status: fraud.census_status,
          note:
            "Pattern signals only (CargoNet 2026: fraud groups acquire clean " +
            "carriers — stale MCS-150 + sudden fleet growth is the tell). " +
            "Fleet-jump history accumulates from our daily census snapshots.",
          flags: fraud.flags,
        },
        boc3_process_agent: critical.boc3,
      },
      data_quality: {
        sources: {
          fmcsa_motus_mirror: critical.freshness,
          fmcsa_census: {
            source: critical.census.source,
            fetched_at: critical.census.fetchedAt.toISOString(),
          },
          fmcsa_inspections: inspectionsResult.ok
            ? {
                source: inspectionsResult.lookup.source,
                fetched_at: inspectionsResult.lookup.fetchedAt.toISOString(),
              }
            : { source: "unavailable", error: inspectionsResult.ok ? null : inspectionsResult.error },
        },
        stale_sources: staleSources,
        excluded_fields: {
          drug_alcohol_status: "employer-query-only",
          community_incident_reports:
            "not available from public data (FreightGuard-class signals are proprietary)",
          basic_percentiles: "masked from public data by FAST Act §5223",
        },
        computed_at: now.toISOString(),
        disclaimer: SMS_DISCLAIMER,
      },
    },
  };
};
