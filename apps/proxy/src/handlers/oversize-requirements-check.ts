/**
 * Oversize Requirements Check — $0.50 verdict answering "can this load
 * move legally, and what will each state on the route demand?". Buyer
 * POSTs load dimensions + origin/destination and gets:
 *
 *   verdict  — LEGAL | PERMITS_REQUIRED | SUPERLOAD_REVIEW
 *   states   — per-state array: permit_required, triggered_by,
 *              escort requirements as codified in that state's OSOW
 *              manual, movement restrictions, fee estimate (always
 *              flagged "verify with state"), superload flag,
 *              source_url + rules_as_of
 *
 * Data: a versioned in-repo dataset (data/oversize-rules/<st>.json,
 * lower-48 + DC) compiled from published state DOT permit pages and
 * manuals. Honesty by construction: unknown values are null in the
 * dataset and surface as verify_with_state — never invented numbers.
 * Fees drift constantly, so fee_estimate carries verify_with_state on
 * every response regardless of dataset confidence.
 *
 * Route model reuses the road-conditions corridor: great-circle line,
 * states detected via cached NWS point metadata. State-LEVEL rules
 * only — county/city permits, bridge engineering and low-clearance
 * routing are explicitly out of scope and disclosed in the payload.
 *
 * Fail-closed: input parsing (free 422), dataset presence, geocoding
 * and states-crossed resolution are all proven BEFORE settlement.
 * Post-settle the handler is pure computation over the dataset — no
 * network I/O, so the auto-refund path should never fire.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerPreflight,
  InternalHandlerResult,
  InternalHandlerValidator,
} from "./types.js";
import { isPlaceholderValue, type InternalHandlerInputSchema } from "./discovery.js";
import {
  corridorPoints,
  haversineKm,
  resolvePlace,
  stateAtPoint,
  type LatLon,
  type ResolvedPlace,
} from "./road-conditions.js";

// ─────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────

const MAX_ROUTE_KM = 5_500;
const MIN_ROUTE_KM = 1;
const STATE_LOOKUP_CONCURRENCY = 4;
/** Preflight 503s when more than this share of corridor state lookups fail. */
const MAX_STATE_LOOKUP_FAILURE = 0.4;
/** Dataset must load at least this many jurisdictions or the product is down. */
const MIN_DATASET_STATES = 45;
const EPS = 1e-6;

/**
 * Overall combination length above which a length permit is assumed.
 * There is no single federal overall-combination limit (STAA preempts
 * on the National Network); state thresholds vary by combination type.
 * 75 ft is the conservative industry-standard planning trigger — the
 * assumption is disclosed in every response, and per-state semitrailer
 * limits are included in the evidence.
 */
const LENGTH_PERMIT_TRIGGER_FT = 75;

/** Conservative fallbacks for superload screening when a state
 * publishes no fixed threshold — used only to raise a "verify" flag,
 * never to assert SUPERLOAD_REVIEW. */
const SUPERLOAD_SCREEN = { width_ft: 16, height_ft: 16, length_ft: 160, gross_weight_lbs: 200_000 };

// ─────────────────────────────────────────────────────────────────────
// Dataset — data/oversize-rules/<st>.json, loaded once per process
// ─────────────────────────────────────────────────────────────────────

export interface EscortRule {
  over_ft: number;
  up_to_ft: number | null;
  escorts: number;
  police: boolean;
  pole_car?: boolean;
  note?: string | null;
}

export interface StateRules {
  state: string;
  state_name: string;
  source_url: string;
  source_title?: string | null;
  portal_url?: string | null;
  retrieved_at: string;
  rules_as_of: string;
  verification: "live_checked" | "knowledge_based";
  data_quality: "ok" | "verify_with_state";
  verify_reasons: string[];
  legal_limits: {
    width_ft: number;
    height_ft: number;
    length_semitrailer_ft: number;
    gross_weight_lbs: number;
  };
  superload_thresholds: {
    width_ft: number | null;
    height_ft: number | null;
    length_ft: number | null;
    gross_weight_lbs: number | null;
    note?: string | null;
  };
  escort_rules: {
    width: EscortRule[];
    height: EscortRule[];
    length: EscortRule[];
    weight: EscortRule[];
  };
  permit_types: {
    single_trip: {
      available: boolean;
      fee_usd_min: number | null;
      fee_usd_max: number | null;
      fee_formula: string | null;
      validity_days?: number | null;
      note?: string | null;
    };
    annual: {
      available: boolean;
      fee_usd_min?: number | null;
      fee_usd_max?: number | null;
      note?: string | null;
    };
  };
  movement_restrictions: string[];
  notes: string[];
}

function validateStateRules(v: unknown, file: string): StateRules {
  const o = v as StateRules;
  const fail = (why: string): never => {
    throw new Error(`oversize-rules ${file}: ${why}`);
  };
  if (typeof o !== "object" || o === null) fail("not an object");
  if (!/^[A-Z]{2}$/.test(o.state ?? "")) fail("bad state code");
  if (typeof o.source_url !== "string" || !o.source_url.startsWith("http")) fail("missing source_url");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.rules_as_of ?? "")) fail("bad rules_as_of");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.retrieved_at ?? "")) fail("bad retrieved_at");
  if (o.data_quality !== "ok" && o.data_quality !== "verify_with_state") fail("bad data_quality");
  const l = o.legal_limits;
  if (!l || typeof l.width_ft !== "number" || typeof l.height_ft !== "number" ||
      typeof l.length_semitrailer_ft !== "number" || typeof l.gross_weight_lbs !== "number") {
    fail("bad legal_limits");
  }
  if (l.width_ft < 8 || l.width_ft > 10 || l.height_ft < 12 || l.height_ft > 15.5 ||
      l.gross_weight_lbs < 60_000 || l.gross_weight_lbs > 200_000) {
    fail("legal_limits out of sane range");
  }
  if (!o.escort_rules || !Array.isArray(o.escort_rules.width)) fail("bad escort_rules");
  for (const dim of ["width", "height", "length", "weight"] as const) {
    const rules = o.escort_rules[dim] ?? [];
    let prev = -Infinity;
    for (const r of rules) {
      if (typeof r.over_ft !== "number" || r.over_ft < prev) fail(`${dim} escort rules unsorted`);
      if (typeof r.escorts !== "number" || r.escorts < 0 || r.escorts > 4) fail(`${dim} escorts out of range`);
      prev = r.over_ft;
    }
  }
  if (!o.permit_types?.single_trip) fail("missing permit_types.single_trip");
  if (!Array.isArray(o.movement_restrictions)) fail("bad movement_restrictions");
  if (o.data_quality === "verify_with_state" && (o.verify_reasons ?? []).length === 0) {
    fail("verify_with_state without verify_reasons");
  }
  return o;
}

let rulesCache: Map<string, StateRules> | null = null;

export function loadOversizeRules(dir?: string): Map<string, StateRules> {
  if (rulesCache !== null && dir === undefined) return rulesCache;
  const base = dir ?? fileURLToPath(new URL("../../data/oversize-rules/", import.meta.url));
  const map = new Map<string, StateRules>();
  for (const f of readdirSync(base)) {
    if (!f.endsWith(".json")) continue;
    const entry = validateStateRules(JSON.parse(readFileSync(`${base}/${f}`, "utf8")), f);
    map.set(entry.state, entry);
  }
  if (dir === undefined) rulesCache = map;
  return map;
}

/** Test seam. */
export function resetOversizeRulesCache(): void {
  rulesCache = null;
}

// ─────────────────────────────────────────────────────────────────────
// Input parsing — feet+inches or decimal feet
// ─────────────────────────────────────────────────────────────────────

export interface OversizeLoad {
  width_ft: number;
  height_ft: number;
  length_ft: number;
  gross_weight_lbs: number;
  axles: number | null;
}

export interface OversizeQuery {
  load: OversizeLoad;
  origin: string;
  destination: string;
}

type ParseResult =
  | { kind: "discovery" }
  | { kind: "invalid_json" }
  | { kind: "malformed" }
  | { kind: "invalid_value"; field: string; detail: string }
  | { kind: "query"; query: OversizeQuery };

/** `<dim>_ft` (decimal) plus optional `<dim>_in` (added as inches). */
function readDimension(
  o: Record<string, unknown>,
  name: string,
): { ok: true; value: number | null } | { ok: false; detail: string } {
  const ft = o[`${name}_ft`];
  const inch = o[`${name}_in`];
  if (ft === undefined && inch === undefined) return { ok: true, value: null };
  let total = 0;
  if (ft !== undefined) {
    if (typeof ft !== "number" || !Number.isFinite(ft) || ft < 0) {
      return { ok: false, detail: `${name}_ft must be a non-negative number of feet` };
    }
    total += ft;
  }
  if (inch !== undefined) {
    if (typeof inch !== "number" || !Number.isFinite(inch) || inch < 0 || inch >= 12) {
      return {
        ok: false,
        detail: `${name}_in is the inches part on top of ${name}_ft and must be in [0, 12) — put whole feet in ${name}_ft`,
      };
    }
    total += inch / 12;
  }
  return { ok: true, value: total };
}

export function parseOversizeQuery(body: Buffer | null): ParseResult {
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
  if (typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "malformed" };
  const o = parsed as Record<string, unknown>;
  if (Object.keys(o).length === 0) return { kind: "discovery" };

  const dims: Record<string, number> = {};
  for (const name of ["width", "height", "length"] as const) {
    const r = readDimension(o, name);
    if (!r.ok) return { kind: "invalid_value", field: name, detail: r.detail };
    if (r.value === null) {
      return {
        kind: "invalid_value",
        field: name,
        detail: `${name}_ft is required (decimal feet; optionally add ${name}_in for inches)`,
      };
    }
    dims[name] = r.value;
  }
  const bounds: Record<string, [number, number]> = {
    width: [3, 40],
    height: [5, 40],
    length: [10, 400],
  };
  for (const [name, [lo, hi]] of Object.entries(bounds)) {
    const v = dims[name]!;
    if (v < lo || v > hi) {
      return {
        kind: "invalid_value",
        field: name,
        detail: `${name} of ${v.toFixed(2)} ft is outside the plausible range ${lo}-${hi} ft`,
      };
    }
  }

  const gw = o["gross_weight_lbs"];
  if (typeof gw !== "number" || !Number.isFinite(gw)) {
    return {
      kind: "invalid_value",
      field: "gross_weight_lbs",
      detail: "gross_weight_lbs is required — total vehicle+load weight in pounds",
    };
  }
  if (gw < 10_000 || gw > 2_000_000) {
    return {
      kind: "invalid_value",
      field: "gross_weight_lbs",
      detail: `gross_weight_lbs of ${gw} is outside the plausible range 10,000-2,000,000`,
    };
  }

  let axles: number | null = null;
  if (o["axles"] !== undefined && o["axles"] !== null) {
    const a = o["axles"];
    if (typeof a !== "number" || !Number.isInteger(a) || a < 2 || a > 20) {
      return { kind: "invalid_value", field: "axles", detail: "axles must be an integer in [2, 20]" };
    }
    axles = a;
  }

  const pick = (k: string): string | null =>
    typeof o[k] === "string" && !isPlaceholderValue(o[k] as string)
      ? (o[k] as string).trim()
      : null;
  const origin = pick("origin") ?? pick("from");
  const destination = pick("destination") ?? pick("dest") ?? pick("to");
  for (const [field, v] of [["origin", origin], ["destination", destination]] as const) {
    if (v === null || v.length < 3) {
      return {
        kind: "invalid_value",
        field,
        detail: `${field} is required — "lat,lon" or a US place name like "Chicago, IL"`,
      };
    }
  }

  return {
    kind: "query",
    query: {
      load: {
        width_ft: dims["width"]!,
        height_ft: dims["height"]!,
        length_ft: dims["length"]!,
        gross_weight_lbs: gw,
        axles,
      },
      origin: origin!,
      destination: destination!,
    },
  };
}

export const oversizeInputSchema: InternalHandlerInputSchema = {
  method: "POST",
  content_type: "application/json",
  body: {
    type: "object",
    required: ["width_ft", "height_ft", "length_ft", "gross_weight_lbs", "origin", "destination"],
    properties: {
      width_ft: { type: "number", description: "Load width in decimal feet (12.5 = 12'6\"). Add width_in for inches instead." },
      width_in: { type: "number", description: "Optional extra inches added to width_ft (e.g. width_ft 12 + width_in 6)." },
      height_ft: { type: "number", description: "Overall height from the road surface, decimal feet. Add height_in for inches." },
      height_in: { type: "number", description: "Optional extra inches added to height_ft." },
      length_ft: { type: "number", description: "Overall combination length (tractor+trailer+overhang), decimal feet. Add length_in for inches." },
      length_in: { type: "number", description: "Optional extra inches added to length_ft." },
      gross_weight_lbs: { type: "number", description: "Gross combination weight in pounds (80000 = federal legal max)." },
      axles: { type: "integer", description: "Optional axle count — echoed for context; axle-group analysis is out of scope in v1." },
      origin: { type: "string", description: 'Route start: "lat,lon" or a US place name (e.g. "Chicago, IL").' },
      destination: { type: "string", description: 'Route end: "lat,lon" or a US place name (e.g. "Houston, TX").' },
    },
  },
  example: {
    width_ft: 12,
    width_in: 6,
    height_ft: 14.5,
    length_ft: 95,
    gross_weight_lbs: 145000,
    axles: 7,
    origin: "Chicago, IL",
    destination: "Houston, TX",
  },
};

export const oversizeValidator: InternalHandlerValidator = (body, _method) => {
  const p = parseOversizeQuery(body);
  switch (p.kind) {
    case "discovery":
    case "query":
      return null;
    case "invalid_json":
      return { status: 400, body: { error: "invalid_json_body" } };
    case "malformed":
      return {
        status: 422,
        body: { error: "load_and_route_required", expected: oversizeInputSchema.example },
      };
    case "invalid_value":
      return {
        status: 422,
        body: {
          error: `invalid_${p.field}`,
          detail: p.detail,
          expected: oversizeInputSchema.example,
        },
      };
  }
};

// ─────────────────────────────────────────────────────────────────────
// Per-state evaluation — pure, exported for tests
// ─────────────────────────────────────────────────────────────────────

export type TriggerDim = "width" | "height" | "length" | "weight";

export interface EscortAssessment {
  pilots: number;
  police: boolean;
  pole_car: boolean;
  label: string;
  matched_rules: Array<{ dimension: TriggerDim; rule: EscortRule }>;
}

function dimValue(load: OversizeLoad, dim: TriggerDim): number {
  switch (dim) {
    case "width": return load.width_ft;
    case "height": return load.height_ft;
    case "length": return load.length_ft;
    case "weight": return load.gross_weight_lbs;
  }
}

export function assessEscorts(rules: StateRules, load: OversizeLoad): EscortAssessment {
  const matched: Array<{ dimension: TriggerDim; rule: EscortRule }> = [];
  let pilots = 0;
  let police = false;
  let poleCar = false;
  for (const dim of ["width", "height", "length", "weight"] as TriggerDim[]) {
    const v = dimValue(load, dim);
    for (const r of rules.escort_rules[dim] ?? []) {
      if (v > r.over_ft + EPS && (r.up_to_ft === null || r.up_to_ft === undefined || v <= r.up_to_ft + EPS)) {
        matched.push({ dimension: dim, rule: r });
        pilots = Math.max(pilots, r.escorts);
        if (r.police) police = true;
        if (r.pole_car) poleCar = true;
      }
    }
  }
  const parts: string[] = [];
  if (pilots > 0) parts.push(pilots === 1 ? "1 pilot" : `${pilots} pilots`);
  if (poleCar) parts.push("pole car (height)");
  if (police) parts.push("police escort");
  return {
    pilots,
    police,
    pole_car: poleCar,
    label: parts.length === 0 ? "none" : parts.join(" + "),
    matched_rules: matched,
  };
}

export interface StateAssessment {
  state: string;
  state_name: string;
  permit_required: boolean;
  triggered_by: TriggerDim[];
  permit_type: "none" | "single-trip";
  annual_permit_available: boolean;
  escort_requirements: string;
  escorts: EscortAssessment;
  movement_restrictions: string[];
  fee_estimate: {
    usd_min: number | null;
    usd_max: number | null;
    formula: string | null;
    verify_with_state: true;
    note: string | null;
    portal_url: string | null;
  };
  superload_threshold_hit: boolean;
  superload_uncertain: boolean;
  legal_limits: StateRules["legal_limits"];
  superload_thresholds: StateRules["superload_thresholds"];
  source_url: string;
  portal_url: string | null;
  rules_as_of: string;
  data_quality: "ok" | "verify_with_state";
  verify_reasons: string[];
  notes: string[];
}

export function assessState(rules: StateRules, load: OversizeLoad): StateAssessment {
  const l = rules.legal_limits;
  const triggered: TriggerDim[] = [];
  if (load.width_ft > l.width_ft + EPS) triggered.push("width");
  if (load.height_ft > l.height_ft + EPS) triggered.push("height");
  const lengthTrigger = Math.max(LENGTH_PERMIT_TRIGGER_FT, l.length_semitrailer_ft);
  if (load.length_ft > lengthTrigger + EPS) triggered.push("length");
  if (load.gross_weight_lbs > l.gross_weight_lbs + EPS) triggered.push("weight");
  const permitRequired = triggered.length > 0;

  const sl = rules.superload_thresholds;
  const slChecks: Array<[number | null, number]> = [
    [sl.width_ft, load.width_ft],
    [sl.height_ft, load.height_ft],
    [sl.length_ft, load.length_ft],
    [sl.gross_weight_lbs, load.gross_weight_lbs],
  ];
  const superloadHit = slChecks.some(([thr, v]) => thr !== null && v > thr - EPS);
  // A state without published thresholds can't clear a screening-size
  // load — flag for manual verification instead of guessing.
  const allNull = slChecks.every(([thr]) => thr === null);
  const screensBig =
    load.width_ft > SUPERLOAD_SCREEN.width_ft - EPS ||
    load.height_ft > SUPERLOAD_SCREEN.height_ft - EPS ||
    load.length_ft > SUPERLOAD_SCREEN.length_ft - EPS ||
    load.gross_weight_lbs > SUPERLOAD_SCREEN.gross_weight_lbs - EPS;
  const superloadUncertain = !superloadHit && allNull && screensBig;

  const escorts = permitRequired
    ? assessEscorts(rules, load)
    : { pilots: 0, police: false, pole_car: false, label: "none", matched_rules: [] };

  const st = rules.permit_types.single_trip;
  return {
    state: rules.state,
    state_name: rules.state_name,
    permit_required: permitRequired,
    triggered_by: triggered,
    permit_type: permitRequired ? "single-trip" : "none",
    annual_permit_available: rules.permit_types.annual?.available === true,
    escort_requirements: escorts.label,
    escorts,
    movement_restrictions: permitRequired ? rules.movement_restrictions : [],
    fee_estimate: {
      usd_min: permitRequired ? st.fee_usd_min : null,
      usd_max: permitRequired ? st.fee_usd_max : null,
      formula: permitRequired ? st.fee_formula : null,
      verify_with_state: true,
      note: permitRequired
        ? st.fee_usd_min === null && st.fee_formula === null
          ? "no published flat fee in dataset — quote through the state portal"
          : st.note ?? null
        : null,
      portal_url: rules.portal_url ?? null,
    },
    superload_threshold_hit: superloadHit,
    superload_uncertain: superloadUncertain,
    legal_limits: rules.legal_limits,
    superload_thresholds: rules.superload_thresholds,
    source_url: rules.source_url,
    portal_url: rules.portal_url ?? null,
    rules_as_of: rules.rules_as_of,
    data_quality: rules.data_quality,
    verify_reasons: rules.verify_reasons ?? [],
    notes: rules.notes ?? [],
  };
}

export type OversizeStatus = "LEGAL" | "PERMITS_REQUIRED" | "SUPERLOAD_REVIEW";

export function computeOversizeVerdict(states: StateAssessment[]): {
  status: OversizeStatus;
  flags: string[];
} {
  const flags: string[] = [];
  const superload = states.filter((s) => s.superload_threshold_hit);
  const permits = states.filter((s) => s.permit_required);
  const uncertain = states.filter((s) => s.superload_uncertain);
  if (superload.length > 0) {
    flags.push(`superload_threshold_hit_in_${superload.map((s) => s.state).join("_")}`);
  }
  if (uncertain.length > 0) flags.push("superload_status_unverifiable_in_some_states");
  if (permits.some((s) => s.escorts.police)) flags.push("police_escort_required_somewhere");
  if (permits.some((s) => s.escorts.pilots >= 2)) flags.push("multiple_pilot_cars_required");
  if (states.some((s) => s.data_quality === "verify_with_state")) {
    flags.push("some_states_flagged_verify_with_state");
  }
  const status: OversizeStatus =
    superload.length > 0 ? "SUPERLOAD_REVIEW" : permits.length > 0 ? "PERMITS_REQUIRED" : "LEGAL";
  return { status, flags };
}

export function buildOversizeSummary(
  status: OversizeStatus,
  load: OversizeLoad,
  states: StateAssessment[],
  originLabel: string,
  destLabel: string,
): string {
  const dims = `${load.width_ft.toFixed(2)}'W x ${load.height_ft.toFixed(2)}'H x ${load.length_ft.toFixed(0)}'L, ${load.gross_weight_lbs.toLocaleString("en-US")} lbs`;
  const head = `${originLabel} -> ${destLabel} (${dims}): ${status}.`;
  if (status === "LEGAL") {
    return `${head} Load is within legal limits in all ${states.length} states on the route - no OS/OW permits needed.`;
  }
  const permits = states.filter((s) => s.permit_required);
  const superload = states.filter((s) => s.superload_threshold_hit);
  const maxPilots = Math.max(0, ...permits.map((s) => s.escorts.pilots));
  const parts = [
    `${permits.length}/${states.length} states require permits (${permits.map((s) => s.state).join(", ")})`,
  ];
  if (maxPilots > 0) parts.push(`up to ${maxPilots} pilot car${maxPilots === 1 ? "" : "s"} required`);
  if (permits.some((s) => s.escorts.police)) parts.push("police escort in at least one state");
  if (superload.length > 0) {
    parts.push(
      `SUPERLOAD in ${superload.map((s) => s.state).join(", ")} - engineering review through the state permit office, no automated fee`,
    );
  }
  return `${head} ${parts.join("; ")}.`;
}

// ─────────────────────────────────────────────────────────────────────
// Critical data (preflight)
// ─────────────────────────────────────────────────────────────────────

interface CriticalData {
  kind: "oversize_requirements_critical";
  origin: ResolvedPlace;
  destination: ResolvedPlace;
  distanceKm: number;
  stateCodes: string[];
  lookupsFailed: number;
  lookupsTotal: number;
}

function isCriticalData(v: unknown): v is CriticalData {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as CriticalData).kind === "oversize_requirements_critical"
  );
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await fn(items[idx]!);
      }
    }),
  );
  return results;
}

type Outcome =
  | { ok: true; data: CriticalData }
  | { ok: false; result: InternalHandlerResult };

async function computeCriticalData(
  input: InternalHandlerInput,
  query: OversizeQuery,
): Promise<Outcome> {
  const db = input.db;
  if (!db) {
    return {
      ok: false,
      result: {
        status: 503,
        body: { error: "critical_source_unavailable", source: "cache_db", detail: "no_db_wired", retryable: true },
      },
    };
  }
  const fetchImpl = input.fetchImpl ?? fetch;

  // Dataset is THE product — prove it loads before anyone pays.
  let rules: Map<string, StateRules>;
  try {
    rules = loadOversizeRules();
    if (rules.size < MIN_DATASET_STATES) throw new Error(`only ${rules.size} states loaded`);
  } catch (err) {
    return {
      ok: false,
      result: {
        status: 503,
        body: {
          error: "critical_source_unavailable",
          source: "oversize_rules_dataset",
          detail: (err as Error).message,
          retryable: true,
        },
      },
    };
  }

  const [o, d] = await Promise.all([
    resolvePlace(db, fetchImpl, query.origin),
    resolvePlace(db, fetchImpl, query.destination),
  ]);
  for (const [field, r] of [["origin", o], ["destination", d]] as const) {
    if (!r.ok) {
      if (r.reason === "not_found") {
        return {
          ok: false,
          result: { status: 422, body: { error: `unresolvable_${field}`, detail: r.detail } },
        };
      }
      return {
        ok: false,
        result: {
          status: 503,
          body: { error: "critical_source_unavailable", source: "geocoder", detail: r.detail, retryable: true },
        },
      };
    }
  }
  const origin = (o as { ok: true; place: ResolvedPlace }).place;
  const destination = (d as { ok: true; place: ResolvedPlace }).place;

  const distanceKm = haversineKm(origin, destination);
  if (distanceKm < MIN_ROUTE_KM || distanceKm > MAX_ROUTE_KM) {
    return {
      ok: false,
      result: {
        status: 422,
        body: {
          error: "route_out_of_range",
          detail: `route is ${Math.round(distanceKm)} km; supported range is ${MIN_ROUTE_KM}-${MAX_ROUTE_KM} km`,
        },
      },
    };
  }

  // States crossed — the product hinges on this, so it is critical and
  // fail-closed, unlike road-conditions where states only scope WZDx.
  const corridor: LatLon[] = corridorPoints(origin, destination);
  const looked = await mapLimit(corridor, STATE_LOOKUP_CONCURRENCY, (pt) =>
    stateAtPoint(db, fetchImpl, pt),
  );
  const failed = looked.filter((s) => s === null).length;
  if (failed / corridor.length > MAX_STATE_LOOKUP_FAILURE) {
    return {
      ok: false,
      result: {
        status: 503,
        body: {
          error: "critical_source_unavailable",
          source: "nws_state_resolution",
          detail: `${failed}/${corridor.length} corridor state lookups failed`,
          retryable: true,
        },
      },
    };
  }
  // Dedupe preserving corridor order.
  const stateCodes: string[] = [];
  for (const s of looked) {
    if (s !== null && !stateCodes.includes(s)) stateCodes.push(s);
  }
  if (stateCodes.length === 0) {
    return {
      ok: false,
      result: {
        status: 503,
        body: {
          error: "critical_source_unavailable",
          source: "nws_state_resolution",
          detail: "could not resolve any state on the corridor",
          retryable: true,
        },
      },
    };
  }
  const unsupported = stateCodes.filter((s) => !rules.has(s));
  if (unsupported.length > 0) {
    return {
      ok: false,
      result: {
        status: 422,
        body: {
          error: "route_outside_coverage",
          detail: `no OS/OW rules coverage for: ${unsupported.join(", ")} (v1 covers the lower-48 states + DC)`,
          states_crossed: stateCodes,
        },
      },
    };
  }

  return {
    ok: true,
    data: {
      kind: "oversize_requirements_critical",
      origin,
      destination,
      distanceKm,
      stateCodes,
      lookupsFailed: failed,
      lookupsTotal: corridor.length,
    },
  };
}

export const oversizePreflight: InternalHandlerPreflight = async (input) => {
  const p = parseOversizeQuery(input.body);
  if (p.kind !== "query") {
    return {
      proceed: false,
      status: 422,
      body: { error: "load_and_route_required", input_schema: oversizeInputSchema },
    };
  }
  const outcome = await computeCriticalData(input, p.query);
  if (!outcome.ok) {
    return { proceed: false, status: outcome.result.status, body: outcome.result.body };
  }
  return { proceed: true, data: outcome.data };
};

// ─────────────────────────────────────────────────────────────────────
// The handler
// ─────────────────────────────────────────────────────────────────────

export const oversizeRequirementsCheck: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  const rejected = oversizeValidator(input.body, input.method);
  if (rejected) return rejected;
  const p = parseOversizeQuery(input.body);
  if (p.kind !== "query") {
    return {
      status: 422,
      body: { error: "load_and_route_required", input_schema: oversizeInputSchema },
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

  const rules = loadOversizeRules();
  const load = p.query.load;
  const states = critical.stateCodes.map((code) => assessState(rules.get(code)!, load));
  const verdict = computeOversizeVerdict(states);

  const { origin, destination } = critical;
  const originLabel = origin.resolved?.split(",")[0] ?? origin.input;
  const destLabel = destination.resolved?.split(",")[0] ?? destination.input;

  const verifyStates = states.filter((s) => s.data_quality === "verify_with_state");
  const oldestRules = states.reduce(
    (min, s) => (s.rules_as_of < min ? s.rules_as_of : min),
    states[0]!.rules_as_of,
  );
  const confidence: "low" | "medium" | "high" =
    verifyStates.length > states.length / 2
      ? "low"
      : verifyStates.length > 0 || states.some((s) => s.superload_uncertain)
        ? "medium"
        : "high";

  return {
    status: 200,
    body: {
      load: {
        width_ft: load.width_ft,
        height_ft: load.height_ft,
        length_ft: load.length_ft,
        gross_weight_lbs: load.gross_weight_lbs,
        axles: load.axles,
      },
      route: {
        origin: { input: origin.input, lat: origin.lat, lon: origin.lon, resolved: origin.resolved },
        destination: {
          input: destination.input,
          lat: destination.lat,
          lon: destination.lon,
          resolved: destination.resolved,
        },
        distance_km: Math.round(critical.distanceKm),
        distance_miles: Math.round(critical.distanceKm * 0.621371),
        states_crossed: critical.stateCodes,
        model:
          "great-circle corridor sampled every ~120 km, states via NWS point metadata - " +
          "planning-grade route, not the permitted route the state will assign",
      },
      verdict: {
        status: verdict.status,
        flags: verdict.flags,
        confidence,
        states_requiring_permits: states.filter((s) => s.permit_required).map((s) => s.state),
        superload_states: states.filter((s) => s.superload_threshold_hit).map((s) => s.state),
        summary: buildOversizeSummary(verdict.status, load, states, originLabel, destLabel),
      },
      states,
      scope: {
        state_level_only: true,
        out_of_scope: [
          "county and city permits",
          "bridge-specific engineering restrictions",
          "low-clearance routing (verify vertical clearances on the assigned route)",
          "axle-group weight analysis (gross weight only in v1)",
        ],
        length_model: `overall combination length; permit trigger assumed at max(75 ft, state semitrailer limit) - state overall-combination thresholds vary by configuration`,
        disclaimer:
          "Informational planning data, NOT a permit and NOT legal advice. Fees are estimates - " +
          "always verify with the state permit office; permits are issued only through state portals or permit services.",
      },
      data_quality: {
        states_flagged_verify_with_state: verifyStates.map((s) => ({
          state: s.state,
          reasons: s.verify_reasons,
        })),
        superload_status_unverifiable: states
          .filter((s) => s.superload_uncertain)
          .map((s) => s.state),
        oldest_rules_as_of: oldestRules,
        state_lookup_coverage: `${critical.lookupsTotal - critical.lookupsFailed}/${critical.lookupsTotal} corridor samples resolved`,
        dataset: "in-repo data/oversize-rules (per-state source_url + rules_as_of included above)",
        computed_at: new Date().toISOString(),
      },
    },
  };
};
