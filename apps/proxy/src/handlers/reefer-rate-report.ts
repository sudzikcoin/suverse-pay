/**
 * Reefer Rate Report — $0.25 produce-lane rate verdict from the USDA
 * AMS Specialty Crops National Truck Rate Report (FVWTRK). Buyer POSTs
 * { origin } (produce shipping region, fuzzy-matched) and optionally
 * { destination } (one of the report's ~10 receiving metros) and gets:
 *
 *   verdict — truck availability (SHORTAGE … SURPLUS) + weekly spot
 *             rate range in USD per load + week-over-week trend
 *   lanes   — the matched lane, or every lane from that region
 *   data_quality — report date, honest scope note
 *
 * HONEST POSITIONING (also in the catalog description): this is the
 * only legally-free truckload lane-rate signal in existence — USDA
 * public domain, weekly, REEFER/PRODUCE LANES ONLY, region→metro
 * granularity. It is NOT a general dry-van lane-rate product and never
 * claims to be.
 *
 * Data plane: scripts/freight/ingest-usda-reefer.mjs parses the weekly
 * PDF (pdftotext) into freight_http_cache['usda:fvwtrk:v1'] on a daily
 * cron; this handler is Postgres-only. Fail-closed pre-settlement when
 * the stored report is missing or stale (>9 days since fetch); unknown
 * regions/destinations are free 422s that carry the full menu, so a
 * buyer never pays to learn the input space.
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

const CACHE_KEY = "usda:fvwtrk:v1";
const MAX_FETCH_AGE_MS = 9 * 86_400_000;

// ─────────────────────────────────────────────────────────────────────
// Stored document shape (written by ingest-usda-reefer.mjs)
// ─────────────────────────────────────────────────────────────────────

export interface ReeferLane {
  destination: string;
  availability: string;
  rate_low_usd: number;
  rate_high_usd: number;
  mostly_low_usd: number | null;
  mostly_high_usd: number | null;
  pct_change_wow: number;
}

export interface ReeferRegion {
  region: string;
  last_report: boolean;
  commodities: string[];
  lanes: ReeferLane[];
}

export interface ReeferDoc {
  report_date: string | null;
  fetched_at: string;
  source: string;
  regions: ReeferRegion[];
}

// ─────────────────────────────────────────────────────────────────────
// Input parsing / validation
// ─────────────────────────────────────────────────────────────────────

interface ReeferQuery {
  origin: string;
  destination: string | null;
}

type ParseResult =
  | { kind: "discovery" }
  | { kind: "invalid_json" }
  | { kind: "malformed" }
  | { kind: "invalid_value"; field: string; detail: string }
  | { kind: "query"; query: ReeferQuery };

export function parseReeferQuery(body: Buffer | null): ParseResult {
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
  const origin = pick("origin") ?? pick("origin_region") ?? pick("region");
  const destination = pick("destination") ?? pick("dest") ?? pick("to");
  if (origin === null && destination === null) return { kind: "discovery" };
  if (origin === null) {
    return {
      kind: "invalid_value",
      field: "origin",
      detail:
        'origin produce region is required, e.g. "salinas", "south texas", "yakima"',
    };
  }
  if (origin.length < 3) {
    return { kind: "invalid_value", field: "origin", detail: "origin is too short" };
  }
  return { kind: "query", query: { origin, destination } };
}

export const reeferRateReportInputSchema: InternalHandlerInputSchema = {
  method: "POST",
  content_type: "application/json",
  body: {
    type: "object",
    required: ["origin"],
    properties: {
      origin: {
        type: "string",
        description:
          'Produce shipping region, fuzzy-matched against the USDA report regions (e.g. "salinas", "kern district", "south texas", "yakima"). Unknown values return a free 422 listing every available region.',
      },
      destination: {
        type: "string",
        description:
          'Optional receiving metro (e.g. "Chicago", "New York"). Omit to get every lane from the origin region.',
      },
    },
  },
  example: { origin: "salinas", destination: "Chicago" },
};

export const reeferRateReportValidator: InternalHandlerValidator = (body, _method) => {
  const p = parseReeferQuery(body);
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
          error: "origin_region_required",
          expected: '{"origin":"salinas","destination":"Chicago"}',
        },
      };
    case "invalid_value":
      return {
        status: 422,
        body: {
          error: `invalid_${p.field}`,
          detail: p.detail,
          expected: reeferRateReportInputSchema.example,
        },
      };
  }
};

// ─────────────────────────────────────────────────────────────────────
// Matching — pure, exported for tests
// ─────────────────────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** All input tokens must appear in the candidate name. */
function tokensMatch(input: string, candidate: string): boolean {
  const c = ` ${norm(candidate)} `;
  return norm(input)
    .split(" ")
    .every((t) => c.includes(` ${t}`) || c.includes(t));
}

export function matchRegions(doc: ReeferDoc, origin: string): ReeferRegion[] {
  return doc.regions.filter((r) => tokensMatch(origin, r.region));
}

export function matchDestination(region: ReeferRegion, destination: string): ReeferLane[] {
  return region.lanes.filter((l) => tokensMatch(destination, l.destination));
}

const AVAILABILITY_TOKEN: Record<string, string> = {
  Surplus: "SURPLUS",
  "Slight Surplus": "SLIGHT_SURPLUS",
  Adequate: "ADEQUATE",
  "Slight Shortage": "SLIGHT_SHORTAGE",
  Shortage: "SHORTAGE",
};

export function trendWord(pct: number): string {
  if (pct >= 10) return "up sharply";
  if (pct >= 3) return "up";
  if (pct <= -10) return "down sharply";
  if (pct <= -3) return "down";
  return "flat";
}

export function buildReeferSummary(
  region: ReeferRegion,
  lanes: ReeferLane[],
  reportDate: string | null,
): string {
  const when = reportDate !== null ? ` (USDA report of ${reportDate})` : "";
  if (lanes.length === 1) {
    const l = lanes[0]!;
    return (
      `${region.region} → ${l.destination}: $${l.rate_low_usd.toLocaleString("en-US")}-` +
      `$${l.rate_high_usd.toLocaleString("en-US")} per reefer load, truck availability ` +
      `${l.availability.toLowerCase()}, rates ${trendWord(l.pct_change_wow)} ` +
      `${l.pct_change_wow >= 0 ? "+" : ""}${l.pct_change_wow}% week-over-week${when}.`
    );
  }
  const worst = [...lanes].sort((a, b) => b.rate_high_usd - a.rate_high_usd)[0]!;
  const avail = lanes[0]?.availability ?? "unknown";
  return (
    `${region.region}: ${lanes.length} reported lanes, truck availability mostly ` +
    `${avail.toLowerCase()}; highest lane ${worst.destination} at ` +
    `$${worst.rate_low_usd.toLocaleString("en-US")}-$${worst.rate_high_usd.toLocaleString("en-US")}${when}.`
  );
}

// ─────────────────────────────────────────────────────────────────────
// Critical data (preflight)
// ─────────────────────────────────────────────────────────────────────

interface CriticalData {
  kind: "reefer_rate_critical";
  doc: ReeferDoc;
  fetchedAt: Date;
  region: ReeferRegion;
  lanes: ReeferLane[];
  destinationInput: string | null;
}

function isCriticalData(v: unknown): v is CriticalData {
  return (
    typeof v === "object" && v !== null && (v as CriticalData).kind === "reefer_rate_critical"
  );
}

type Outcome = { ok: true; data: CriticalData } | { ok: false; result: InternalHandlerResult };

async function computeCriticalData(
  input: InternalHandlerInput,
  query: ReeferQuery,
): Promise<Outcome> {
  const db = input.db;
  if (!db) {
    return fail503("no_db_wired");
  }
  let doc: ReeferDoc;
  let fetchedAt: Date;
  try {
    const { rows } = await db.query(
      `SELECT payload, fetched_at FROM freight_http_cache WHERE cache_key = $1`,
      [CACHE_KEY],
    );
    if (rows.length === 0) {
      return fail503("usda fvwtrk report not ingested yet");
    }
    const row = rows[0] as { payload: unknown; fetched_at: Date | string };
    doc = row.payload as ReeferDoc;
    fetchedAt = new Date(row.fetched_at);
  } catch (err) {
    return fail503(`report_read_failed: ${(err as Error).message}`);
  }
  if (Date.now() - fetchedAt.getTime() > MAX_FETCH_AGE_MS) {
    return fail503(
      `stored USDA report is stale (fetched ${fetchedAt.toISOString()}) — refusing to sell outdated rates`,
    );
  }
  if (!Array.isArray(doc.regions) || doc.regions.length === 0) {
    return fail503("stored USDA report is empty");
  }

  const regionMenu = doc.regions.map((r) => r.region);
  const matches = matchRegions(doc, query.origin);
  if (matches.length === 0) {
    return {
      ok: false,
      result: {
        status: 422,
        body: {
          error: "unknown_origin_region",
          detail:
            `"${query.origin}" matches no region in the current USDA report; ` +
            "this menu is free (no payment was settled)",
          available_regions: regionMenu,
        },
      },
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      result: {
        status: 422,
        body: {
          error: "ambiguous_origin_region",
          detail: "multiple regions match — re-query with one of these (free, unpaid)",
          candidates: matches.map((r) => r.region),
        },
      },
    };
  }
  const region = matches[0]!;

  let lanes = region.lanes;
  if (query.destination !== null) {
    lanes = matchDestination(region, query.destination);
    if (lanes.length === 0) {
      return {
        ok: false,
        result: {
          status: 422,
          body: {
            error: "unknown_destination",
            detail:
              `"${query.destination}" is not a reported destination for ${region.region}; ` +
              "this menu is free (no payment was settled)",
            available_destinations: region.lanes.map((l) => l.destination),
          },
        },
      };
    }
  }

  return {
    ok: true,
    data: {
      kind: "reefer_rate_critical",
      doc,
      fetchedAt,
      region,
      lanes,
      destinationInput: query.destination,
    },
  };

  function fail503(detail: string): Outcome {
    return {
      ok: false,
      result: {
        status: 503,
        body: {
          error: "critical_source_unavailable",
          source: "usda_fvwtrk",
          detail,
          retryable: true,
        },
      },
    };
  }
}

export const reeferRateReportPreflight: InternalHandlerPreflight = async (input) => {
  const p = parseReeferQuery(input.body);
  if (p.kind !== "query") {
    return {
      proceed: false,
      status: 422,
      body: { error: "origin_region_required", input_schema: reeferRateReportInputSchema },
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

export const reeferRateReport: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  const rejected = reeferRateReportValidator(input.body, input.method);
  if (rejected) return rejected;
  const p = parseReeferQuery(input.body);
  if (p.kind !== "query") {
    return {
      status: 422,
      body: { error: "origin_region_required", input_schema: reeferRateReportInputSchema },
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

  const { doc, region, lanes } = critical;
  const now = new Date();
  const primary = lanes.length === 1 ? lanes[0]! : null;

  return {
    status: 200,
    body: {
      lane: {
        origin_region: region.region,
        destination: primary?.destination ?? null,
        commodities_reported: region.commodities,
      },
      verdict: {
        truck_availability: primary
          ? (AVAILABILITY_TOKEN[primary.availability] ?? primary.availability.toUpperCase())
          : null,
        rate_range_usd_per_load: primary
          ? [primary.rate_low_usd, primary.rate_high_usd]
          : null,
        mostly_usd_per_load:
          primary && primary.mostly_low_usd !== null
            ? [primary.mostly_low_usd, primary.mostly_high_usd]
            : null,
        trend_wow_pct: primary?.pct_change_wow ?? null,
        trend: primary ? trendWord(primary.pct_change_wow) : null,
        confidence: region.last_report ? "medium" : "high",
        summary: buildReeferSummary(region, lanes, doc.report_date),
      },
      lanes: lanes.map((l) => ({
        destination: l.destination,
        truck_availability: AVAILABILITY_TOKEN[l.availability] ?? l.availability.toUpperCase(),
        rate_low_usd: l.rate_low_usd,
        rate_high_usd: l.rate_high_usd,
        mostly_low_usd: l.mostly_low_usd,
        mostly_high_usd: l.mostly_high_usd,
        pct_change_wow: l.pct_change_wow,
      })),
      data_quality: {
        report_date: doc.report_date,
        fetched_at: critical.fetchedAt.toISOString(),
        source: "USDA AMS Specialty Crops National Truck Rate Report (FVWTRK), public domain",
        region_is_last_report: region.last_report,
        last_report_note: region.last_report
          ? "USDA marked this region 'LAST REPORT' — data carried from the prior week"
          : null,
        scope:
          "Reefer/produce spot rates only, region→metro granularity, weekly. " +
          "This is NOT a general dry-van lane-rate product.",
        computed_at: now.toISOString(),
      },
    },
  };
};
