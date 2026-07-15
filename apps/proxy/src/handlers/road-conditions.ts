/**
 * Road Conditions — $0.25 corridor verdict answering "what's between me
 * and the consignee right now?". Buyer POSTs { origin, destination }
 * (each "lat,lon" or a US place name) and gets:
 *
 *   verdict     — CLEAR | CAUTION | SEVERE + flags + summary
 *   weather     — deduped active NWS alerts sampled along the corridor
 *   work_zones  — WZDx work-zone events within 30km of the corridor,
 *                 closure counts first
 *   coverage    — the honest part: NWS is nationwide; WZDx only exists
 *                 in states that publish a keyless feed, and flaky state
 *                 feeds fail visibly into coverage.feeds_failed, never
 *                 silently
 *
 * Sources: api.weather.gov (free, requires a contact User-Agent),
 * the WZDx Feed Registry on data.transportation.gov (69qe-yiui) and the
 * state DOT feeds it points to, and Nominatim for place-name geocoding
 * (cached 30 days; skipped entirely when coordinates are supplied).
 *
 * Fail-closed: geocoding and an NWS probe at the origin are proven
 * BEFORE settlement. Post-settle, individual sample points or state
 * feeds may fail — those degrade with disclosure; if weather coverage
 * drops below half the corridor the handler 503s and the existing
 * auto-refund path returns the payment.
 *
 * Corridor model (v1, disclosed in the response): a great-circle line
 * between the endpoints sampled every ~120km — no road routing. Good
 * for zone-scale weather and interstate work zones; not a turn-by-turn
 * hazard list.
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
import { httpCachedLookup, sodaFetch } from "./fmcsa-shared.js";

// ─────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────

const NWS_BASE = "https://api.weather.gov";
const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const WZDX_REGISTRY_DATASET = "69qe-yiui";

// api.weather.gov requires a User-Agent with contact info.
export const CONTACT_UA =
  "SuVerse-GovHub/1.0 (https://api.suverse.io; sudzikgroup@gmail.com)";

const SAMPLE_STEP_KM = 120;
const MAX_SAMPLE_POINTS = 25;
const MAX_ROUTE_KM = 5_500;
const MIN_ROUTE_KM = 1;
const CORRIDOR_BUFFER_KM = 30;
const MAX_REPORTED_EVENTS = 50;
const FETCH_TIMEOUT_MS = 10_000;
const FEED_TIMEOUT_MS = 12_000;
const ALERT_CONCURRENCY = 6;
const MAX_STATE_FEEDS = 8;
/** Handler 503s (→ auto-refund) if fewer than this share of corridor
 * weather samples succeed. */
const MIN_WEATHER_COVERAGE = 0.5;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// Weather events that make a Severe-severity warning corridor-blocking
// for a truck.
const SEVERE_EVENT_RE =
  /blizzard|ice storm|winter storm|tornado|hurricane|flash flood|high wind|dust storm|tropical storm|extreme cold|extreme wind/i;

// NWS 2-letter state → WZDx registry state name (lowercase full name).
const STATE_NAMES: Record<string, string> = {
  AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california",
  CO: "colorado", CT: "connecticut", DE: "delaware", FL: "florida", GA: "georgia",
  HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa",
  KS: "kansas", KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland",
  MA: "massachusetts", MI: "michigan", MN: "minnesota", MS: "mississippi",
  MO: "missouri", MT: "montana", NE: "nebraska", NV: "nevada", NH: "new hampshire",
  NJ: "new jersey", NM: "new mexico", NY: "new york", NC: "north carolina",
  ND: "north dakota", OH: "ohio", OK: "oklahoma", OR: "oregon", PA: "pennsylvania",
  RI: "rhode island", SC: "south carolina", SD: "south dakota", TN: "tennessee",
  TX: "texas", UT: "utah", VT: "vermont", VA: "virginia", WA: "washington",
  WV: "west virginia", WI: "wisconsin", WY: "wyoming", DC: "district of columbia",
};

// ─────────────────────────────────────────────────────────────────────
// Geometry — pure, exported for tests
// ─────────────────────────────────────────────────────────────────────

export interface LatLon {
  lat: number;
  lon: number;
}

export function parseLatLon(s: string): LatLon | null {
  const m = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(s);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

const R_EARTH_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Spherical linear interpolation between two points. */
export function interpolate(a: LatLon, b: LatLon, f: number): LatLon {
  const φ1 = rad(a.lat), λ1 = rad(a.lon);
  const φ2 = rad(b.lat), λ2 = rad(b.lon);
  const δ = haversineKm(a, b) / R_EARTH_KM;
  if (δ < 1e-9) return a;
  const sinδ = Math.sin(δ);
  const A = Math.sin((1 - f) * δ) / sinδ;
  const B = Math.sin(f * δ) / sinδ;
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return {
    lat: deg(Math.atan2(z, Math.sqrt(x * x + y * y))),
    lon: deg(Math.atan2(y, x)),
  };
}

/** Great-circle corridor samples, endpoints included. */
export function corridorPoints(a: LatLon, b: LatLon): LatLon[] {
  const dist = haversineKm(a, b);
  const n = Math.min(
    MAX_SAMPLE_POINTS,
    Math.max(2, Math.ceil(dist / SAMPLE_STEP_KM) + 1),
  );
  const pts: LatLon[] = [];
  for (let i = 0; i < n; i++) pts.push(interpolate(a, b, i / (n - 1)));
  return pts;
}

/**
 * Distance from a point to the corridor polyline, in km — local
 * equirectangular projection per segment (fine at ≤200km segments).
 */
export function distanceToCorridorKm(p: LatLon, corridor: LatLon[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < corridor.length; i++) {
    const a = corridor[i]!;
    const b = corridor[i + 1]!;
    const kx = Math.cos(rad(p.lat)) * 111.32;
    const ky = 110.57;
    const ax = (a.lon - p.lon) * kx, ay = (a.lat - p.lat) * ky;
    const bx = (b.lon - p.lon) * kx, by = (b.lat - p.lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const cx = ax + t * dx, cy = ay + t * dy;
    best = Math.min(best, Math.sqrt(cx * cx + cy * cy));
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────
// Input parsing / validation
// ─────────────────────────────────────────────────────────────────────

interface RouteQuery {
  origin: string;
  destination: string;
}

type ParseResult =
  | { kind: "discovery" }
  | { kind: "invalid_json" }
  | { kind: "malformed" }
  | { kind: "invalid_value"; field: string; detail: string }
  | { kind: "query"; query: RouteQuery };

export function parseRouteQuery(body: Buffer | null): ParseResult {
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
  const origin = pick("origin") ?? pick("from");
  const destination = pick("destination") ?? pick("dest") ?? pick("to");
  if (origin === null && destination === null) return { kind: "discovery" };
  for (const [field, v] of [
    ["origin", origin],
    ["destination", destination],
  ] as const) {
    if (v === null) {
      return {
        kind: "invalid_value",
        field,
        detail: `${field} is required — "lat,lon" or a US place name like "Chicago, IL"`,
      };
    }
    if (v.length < 3) {
      return { kind: "invalid_value", field, detail: `${field} is too short` };
    }
  }
  return { kind: "query", query: { origin: origin!, destination: destination! } };
}

export const roadConditionsInputSchema: InternalHandlerInputSchema = {
  method: "POST",
  content_type: "application/json",
  body: {
    type: "object",
    required: ["origin", "destination"],
    properties: {
      origin: {
        type: "string",
        description:
          'Route start: "lat,lon" (e.g. "41.88,-87.63") or a US place name (e.g. "Chicago, IL").',
      },
      destination: {
        type: "string",
        description: 'Route end: "lat,lon" or a US place name (e.g. "Atlanta, GA").',
      },
    },
  },
  example: { origin: "Chicago, IL", destination: "Atlanta, GA" },
};

export const roadConditionsValidator: InternalHandlerValidator = (body, _method) => {
  const p = parseRouteQuery(body);
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
          error: "route_required",
          expected: '{"origin":"Chicago, IL","destination":"Atlanta, GA"}',
        },
      };
    case "invalid_value":
      return {
        status: 422,
        body: {
          error: `invalid_${p.field}`,
          detail: p.detail,
          expected: roadConditionsInputSchema.example,
        },
      };
  }
};

// ─────────────────────────────────────────────────────────────────────
// Upstream fetch helpers
// ─────────────────────────────────────────────────────────────────────

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  accept = "application/json",
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { "user-agent": CONTACT_UA, accept },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`status_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export interface ResolvedPlace extends LatLon {
  input: string;
  resolved: string | null;
}

/** "lat,lon" passes through; anything else geocodes via Nominatim (30d cache). */
export async function resolvePlace(
  db: DbQuerier,
  fetchImpl: typeof fetch,
  input: string,
): Promise<
  | { ok: true; place: ResolvedPlace }
  | { ok: false; reason: "not_found" | "upstream_down"; detail: string }
> {
  const direct = parseLatLon(input);
  if (direct !== null) {
    return { ok: true, place: { ...direct, input, resolved: null } };
  }
  const key = `geocode:v1:${input.toLowerCase().replace(/\s+/g, " ").trim()}`;
  try {
    const lookup = await httpCachedLookup(db, key, 30 * DAY_MS, 90 * DAY_MS, async () => {
      const url =
        `${NOMINATIM_BASE}/search?format=json&limit=1&countrycodes=us` +
        `&q=${encodeURIComponent(input)}`;
      const data = await fetchJson(fetchImpl, url, FETCH_TIMEOUT_MS);
      if (!Array.isArray(data)) throw new Error("geocoder_bad_shape");
      if (data.length === 0) return null;
      const hit = data[0] as Record<string, unknown>;
      return {
        lat: Number(hit["lat"]),
        lon: Number(hit["lon"]),
        display: String(hit["display_name"] ?? ""),
      };
    });
    if (lookup.value === null) {
      return {
        ok: false,
        reason: "not_found",
        detail: `could not geocode "${input}" — pass "lat,lon" instead`,
      };
    }
    const v = lookup.value;
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) {
      return { ok: false, reason: "not_found", detail: `bad geocode for "${input}"` };
    }
    return {
      ok: true,
      place: { lat: v.lat, lon: v.lon, input, resolved: v.display },
    };
  } catch (err) {
    return { ok: false, reason: "upstream_down", detail: (err as Error).message };
  }
}

export interface NwsAlert {
  id: string;
  event: string;
  severity: string;
  urgency: string;
  headline: string | null;
  area: string | null;
  onset: string | null;
  ends: string | null;
  sender: string | null;
}

function parseAlerts(data: unknown): NwsAlert[] {
  const features = (data as { features?: unknown[] })?.features;
  if (!Array.isArray(features)) return [];
  return features.map((f) => {
    const p = ((f as Record<string, unknown>)["properties"] ?? {}) as Record<string, unknown>;
    return {
      id: String(p["id"] ?? ""),
      event: String(p["event"] ?? "Unknown"),
      severity: String(p["severity"] ?? "Unknown"),
      urgency: String(p["urgency"] ?? "Unknown"),
      headline: p["headline"] === null || p["headline"] === undefined ? null : String(p["headline"]),
      area: p["areaDesc"] === undefined ? null : String(p["areaDesc"]),
      onset: p["onset"] === null || p["onset"] === undefined ? null : String(p["onset"]),
      ends: p["ends"] === null || p["ends"] === undefined ? null : String(p["ends"]),
      sender: p["senderName"] === undefined ? null : String(p["senderName"]),
    };
  });
}

const roundPt = (p: LatLon) => `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;

async function alertsAtPoint(
  db: DbQuerier,
  fetchImpl: typeof fetch,
  p: LatLon,
): Promise<NwsAlert[]> {
  const lookup = await httpCachedLookup(
    db,
    `nws:alerts:${roundPt(p)}`,
    5 * 60_000,
    30 * 60_000,
    async () => {
      const url = `${NWS_BASE}/alerts/active?point=${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
      return (await fetchJson(fetchImpl, url, FETCH_TIMEOUT_MS, "application/geo+json")) as unknown;
    },
  );
  return parseAlerts(lookup.value);
}

export async function stateAtPoint(
  db: DbQuerier,
  fetchImpl: typeof fetch,
  p: LatLon,
): Promise<string | null> {
  try {
    const lookup = await httpCachedLookup(
      db,
      `nws:state:${roundPt(p)}`,
      30 * DAY_MS,
      90 * DAY_MS,
      async () => {
        const url = `${NWS_BASE}/points/${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
        const data = (await fetchJson(fetchImpl, url, FETCH_TIMEOUT_MS)) as Record<string, any>;
        return data?.["properties"]?.["relativeLocation"]?.["properties"]?.["state"] ?? null;
      },
    );
    return lookup.value === null ? null : String(lookup.value).toUpperCase();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// WZDx
// ─────────────────────────────────────────────────────────────────────

interface RegistryFeed {
  state: string;
  url: string;
  feedname: string;
  version: string;
}

async function wzdxRegistry(
  db: DbQuerier,
  fetchImpl: typeof fetch,
): Promise<RegistryFeed[]> {
  const lookup = await httpCachedLookup(db, "wzdx:registry:v1", DAY_MS, 7 * DAY_MS, async () => {
    const rows = await sodaFetch(fetchImpl, WZDX_REGISTRY_DATASET, { $limit: "200" });
    return rows
      .map((r) => {
        const o = r as Record<string, any>;
        if (o["active"] !== true || o["needapikey"] === true) return null;
        const url = o["url"]?.["url"];
        if (typeof url !== "string" || url.length === 0) return null;
        return {
          state: String(o["state"] ?? "").toLowerCase(),
          url,
          feedname: String(o["feedname"] ?? o["state"] ?? "feed"),
          version: String(o["version"] ?? "?"),
        };
      })
      .filter((f): f is RegistryFeed => f !== null);
  });
  return lookup.value;
}

export interface WorkZoneEvent {
  road_names: string[];
  direction: string | null;
  vehicle_impact: string | null;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  state: string;
  distance_from_corridor_km: number;
}

function geometryCoords(geometry: unknown): Array<[number, number]> {
  const g = geometry as { type?: string; coordinates?: unknown };
  if (!g || typeof g.type !== "string" || g.coordinates === undefined) return [];
  const c = g.coordinates as any;
  switch (g.type) {
    case "Point":
      return [c as [number, number]];
    case "MultiPoint":
    case "LineString":
      return c as Array<[number, number]>;
    case "MultiLineString":
    case "Polygon":
      return (c as Array<Array<[number, number]>>).flat();
    default:
      return [];
  }
}

/** Parse a WZDx GeoJSON body into corridor-relevant work-zone events. */
export function extractWorkZones(
  feedBody: unknown,
  state: string,
  corridor: LatLon[],
  now: Date,
): WorkZoneEvent[] {
  const features = (feedBody as { features?: unknown[] })?.features;
  if (!Array.isArray(features)) return [];
  const corridorBox = {
    minLat: Math.min(...corridor.map((p) => p.lat)) - 0.6,
    maxLat: Math.max(...corridor.map((p) => p.lat)) + 0.6,
    minLon: Math.min(...corridor.map((p) => p.lon)) - 0.6,
    maxLon: Math.max(...corridor.map((p) => p.lon)) + 0.6,
  };
  const out: WorkZoneEvent[] = [];
  for (const f of features) {
    const feat = f as Record<string, any>;
    const props = (feat["properties"] ?? {}) as Record<string, any>;
    const core = (props["core_details"] ?? props) as Record<string, any>;
    const eventType = core["event_type"];
    if (typeof eventType === "string" && eventType !== "work-zone") continue;
    const start = props["start_date"] ?? core["start_date"] ?? null;
    const end = props["end_date"] ?? core["end_date"] ?? null;
    if (typeof start === "string") {
      const s = new Date(start).getTime();
      if (Number.isFinite(s) && s > now.getTime() + 24 * HOUR_MS) continue;
    }
    if (typeof end === "string") {
      const e = new Date(end).getTime();
      if (Number.isFinite(e) && e < now.getTime()) continue;
    }
    const coords = geometryCoords(feat["geometry"]);
    if (coords.length === 0) continue;
    // Cheap bbox prefilter before exact distance (NY has 7k+ events).
    const inBox = coords.some(
      ([lon, lat]) =>
        lat >= corridorBox.minLat &&
        lat <= corridorBox.maxLat &&
        lon >= corridorBox.minLon &&
        lon <= corridorBox.maxLon,
    );
    if (!inBox) continue;
    let minKm = Infinity;
    for (const [lon, lat] of coords) {
      minKm = Math.min(minKm, distanceToCorridorKm({ lat, lon }, corridor));
      if (minKm <= 1) break;
    }
    if (minKm > CORRIDOR_BUFFER_KM) continue;
    const roadNames = Array.isArray(core["road_names"])
      ? core["road_names"].map((r: unknown) => String(r))
      : [];
    out.push({
      road_names: roadNames,
      direction: core["direction"] === undefined ? null : String(core["direction"]),
      vehicle_impact:
        props["vehicle_impact"] === undefined ? null : String(props["vehicle_impact"]),
      description:
        core["description"] === undefined || core["description"] === null
          ? null
          : String(core["description"]).slice(0, 200),
      start_date: typeof start === "string" ? start : null,
      end_date: typeof end === "string" ? end : null,
      state,
      distance_from_corridor_km: Math.round(minKm * 10) / 10,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Verdict — pure, exported for tests
// ─────────────────────────────────────────────────────────────────────

export type RoadStatus = "CLEAR" | "CAUTION" | "SEVERE";

export interface RoadVerdict {
  status: RoadStatus;
  flags: string[];
}

export function computeRoadVerdict(
  alerts: NwsAlert[],
  workZones: WorkZoneEvent[],
): RoadVerdict {
  const flags: string[] = [];
  const extreme = alerts.filter((a) => a.severity === "Extreme");
  const severeWeather = alerts.filter(
    (a) => a.severity === "Severe" && SEVERE_EVENT_RE.test(a.event),
  );
  const otherSevere = alerts.filter(
    (a) => (a.severity === "Severe" || a.severity === "Moderate") &&
      !severeWeather.includes(a) && !extreme.includes(a),
  );
  // A closure 25km off the straight line is usually a local road, not
  // the lane the truck is in — only near-corridor full closures (≤10km)
  // drive SEVERE; the rest stay CAUTION-grade.
  const allClosures = workZones.filter((w) => w.vehicle_impact === "all-lanes-closed");
  const fullClosures = allClosures.filter((w) => w.distance_from_corridor_km <= 10);
  const laneClosures = workZones.filter(
    (w) =>
      w.vehicle_impact === "some-lanes-closed" ||
      (w.vehicle_impact === "all-lanes-closed" && w.distance_from_corridor_km > 10),
  );

  if (extreme.length > 0) flags.push("extreme_weather_alert_on_corridor");
  if (severeWeather.length > 0) flags.push("severe_winter_or_wind_warning_on_corridor");
  if (fullClosures.length > 0) flags.push("full_road_closure_work_zone_on_corridor");
  if (otherSevere.length > 0) flags.push("weather_advisories_on_corridor");
  if (laneClosures.length > 0) flags.push("lane_closure_work_zones_on_corridor");
  if (workZones.length >= 10) flags.push("dense_work_zone_activity");

  let status: RoadStatus;
  if (extreme.length > 0 || severeWeather.length > 0 || fullClosures.length > 0) {
    status = "SEVERE";
  } else if (otherSevere.length > 0 || laneClosures.length > 0 || workZones.length >= 10) {
    status = "CAUTION";
  } else {
    status = "CLEAR";
  }
  return { status, flags };
}

export function buildRoadSummary(
  v: RoadVerdict,
  originLabel: string,
  destLabel: string,
  distanceKm: number,
  alerts: NwsAlert[],
  workZones: WorkZoneEvent[],
): string {
  const first = `${originLabel} → ${destLabel} (${Math.round(distanceKm)} km): ${v.status}.`;
  const topAlerts = [...new Set(alerts.map((a) => a.event))].slice(0, 4);
  const weatherPart =
    alerts.length > 0
      ? `${alerts.length} active NWS alert${alerts.length === 1 ? "" : "s"} on the corridor (${topAlerts.join(", ")})`
      : "no active NWS alerts on the corridor";
  const closures = workZones.filter((w) => w.vehicle_impact === "all-lanes-closed").length;
  const wzPart =
    workZones.length > 0
      ? `${workZones.length} work zone${workZones.length === 1 ? "" : "s"} within ${CORRIDOR_BUFFER_KM} km` +
        (closures > 0 ? ` including ${closures} full closure${closures === 1 ? "" : "s"}` : "")
      : "no reported work zones in covered states";
  return `${first} ${weatherPart}; ${wzPart}.`;
}

// ─────────────────────────────────────────────────────────────────────
// Critical data (preflight)
// ─────────────────────────────────────────────────────────────────────

interface CriticalData {
  kind: "road_conditions_critical";
  origin: ResolvedPlace;
  destination: ResolvedPlace;
  corridor: LatLon[];
  distanceKm: number;
  originAlerts: NwsAlert[];
}

function isCriticalData(v: unknown): v is CriticalData {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as CriticalData).kind === "road_conditions_critical"
  );
}

type Outcome =
  | { ok: true; data: CriticalData }
  | { ok: false; result: InternalHandlerResult };

async function computeCriticalData(
  input: InternalHandlerInput,
  query: RouteQuery,
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

  const [o, d] = await Promise.all([
    resolvePlace(db, fetchImpl, query.origin),
    resolvePlace(db, fetchImpl, query.destination),
  ]);
  for (const [field, r] of [["origin", o], ["destination", d]] as const) {
    if (!r.ok) {
      if (r.reason === "not_found") {
        return {
          ok: false,
          result: {
            status: 422,
            body: { error: `unresolvable_${field}`, detail: r.detail },
          },
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
  const corridor = corridorPoints(origin, destination);

  // Critical NWS probe at the origin — fail-closed, buyer not charged.
  let originAlerts: NwsAlert[];
  try {
    originAlerts = await alertsAtPoint(db, fetchImpl, origin);
  } catch (err) {
    return {
      ok: false,
      result: {
        status: 503,
        body: {
          error: "critical_source_unavailable",
          source: "nws_alerts",
          detail: (err as Error).message,
          retryable: true,
        },
      },
    };
  }

  return {
    ok: true,
    data: {
      kind: "road_conditions_critical",
      origin,
      destination,
      corridor,
      distanceKm,
      originAlerts,
    },
  };
}

export const roadConditionsPreflight: InternalHandlerPreflight = async (input) => {
  const p = parseRouteQuery(input.body);
  if (p.kind !== "query") {
    return {
      proceed: false,
      status: 422,
      body: { error: "route_required", input_schema: roadConditionsInputSchema },
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

export const roadConditions: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  const rejected = roadConditionsValidator(input.body, input.method);
  if (rejected) return rejected;
  const p = parseRouteQuery(input.body);
  if (p.kind !== "query") {
    return {
      status: 422,
      body: { error: "route_required", input_schema: roadConditionsInputSchema },
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

  const db = input.db!;
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = new Date();
  const { corridor, origin, destination, distanceKm } = critical;

  // 1. Weather along the corridor (origin already fetched in preflight).
  const restPoints = corridor.slice(1);
  const alertResults = await mapLimit(restPoints, ALERT_CONCURRENCY, async (pt) => {
    try {
      return { ok: true as const, alerts: await alertsAtPoint(db, fetchImpl, pt) };
    } catch {
      return { ok: false as const };
    }
  });
  const okSamples = 1 + alertResults.filter((r) => r.ok).length;
  const weatherCoverage = okSamples / corridor.length;
  if (weatherCoverage < MIN_WEATHER_COVERAGE) {
    // Paid path: dispatcher auto-refunds on ≥500.
    return {
      status: 503,
      body: {
        error: "weather_coverage_degraded",
        detail: `only ${okSamples}/${corridor.length} corridor samples reachable on api.weather.gov`,
        retryable: true,
      },
    };
  }
  const alertMap = new Map<string, NwsAlert>();
  for (const a of critical.originAlerts) alertMap.set(a.id, a);
  for (const r of alertResults) {
    if (r.ok) for (const a of r.alerts) alertMap.set(a.id, a);
  }
  const alerts = [...alertMap.values()].sort((a, b) => {
    const rank = (s: string) =>
      s === "Extreme" ? 0 : s === "Severe" ? 1 : s === "Moderate" ? 2 : 3;
    return rank(a.severity) - rank(b.severity);
  });

  // 2. States crossed (≤8 cached NWS point-metadata lookups).
  const stateStep = Math.max(1, Math.ceil(corridor.length / 8));
  const statePts = corridor.filter((_, i) => i % stateStep === 0 || i === corridor.length - 1);
  const stateCodes = [
    ...new Set(
      (await mapLimit(statePts, 4, (pt) => stateAtPoint(db, fetchImpl, pt))).filter(
        (s): s is string => s !== null,
      ),
    ),
  ];
  const stateNames = stateCodes
    .map((c) => STATE_NAMES[c])
    .filter((s): s is string => s !== undefined);

  // 3. WZDx feeds for the states crossed.
  let registry: RegistryFeed[] = [];
  let registryFailed = false;
  try {
    registry = await wzdxRegistry(db, fetchImpl);
  } catch {
    registryFailed = true;
  }
  const feedsToFetch = registry
    .filter((f) => stateNames.includes(f.state))
    .slice(0, MAX_STATE_FEEDS);
  const statesWithFeed = [...new Set(feedsToFetch.map((f) => f.state))];
  const feedsFailed: string[] = [];
  const workZones: WorkZoneEvent[] = [];
  await mapLimit(feedsToFetch, 4, async (feed) => {
    try {
      const lookup = await httpCachedLookup(
        db,
        `wzdx:feed:${feed.feedname}`,
        15 * 60_000,
        2 * HOUR_MS,
        () => fetchJson(fetchImpl, feed.url, FEED_TIMEOUT_MS),
      );
      workZones.push(...extractWorkZones(lookup.value, feed.state, corridor, now));
    } catch {
      feedsFailed.push(`${feed.state} (${feed.feedname})`);
    }
  });
  const impactRank = (w: WorkZoneEvent) =>
    w.vehicle_impact === "all-lanes-closed" ? 0 : w.vehicle_impact === "some-lanes-closed" ? 1 : 2;
  workZones.sort(
    (a, b) => impactRank(a) - impactRank(b) || a.distance_from_corridor_km - b.distance_from_corridor_km,
  );

  const verdict = computeRoadVerdict(alerts, workZones);
  const statesWithoutFeed = stateNames.filter((s) => !statesWithFeed.includes(s));
  const okFeedStates = statesWithFeed.filter(
    (s) => !feedsFailed.some((f) => f.startsWith(s)),
  );

  const originLabel = origin.resolved?.split(",")[0] ?? origin.input;
  const destLabel = destination.resolved?.split(",")[0] ?? destination.input;
  const staleSources: string[] = [];
  if (weatherCoverage < 1) staleSources.push("nws_alerts_partial");
  if (registryFailed) staleSources.push("wzdx_registry");
  if (feedsFailed.length > 0) staleSources.push("wzdx_feeds_partial");
  const confidence: "low" | "medium" | "high" =
    registryFailed || weatherCoverage < 0.8
      ? "low"
      : staleSources.length > 0 || statesWithoutFeed.length > 0
        ? "medium"
        : "high";

  return {
    status: 200,
    body: {
      route: {
        origin: { input: origin.input, lat: origin.lat, lon: origin.lon, resolved: origin.resolved },
        destination: {
          input: destination.input,
          lat: destination.lat,
          lon: destination.lon,
          resolved: destination.resolved,
        },
        distance_km: Math.round(distanceKm),
        corridor_sample_points: corridor.length,
        states_crossed: stateCodes,
        model:
          "great-circle corridor sampled every ~120 km with a 30 km work-zone buffer — zone-scale conditions, not turn-by-turn routing",
      },
      verdict: {
        status: verdict.status,
        flags: verdict.flags,
        confidence,
        summary: buildRoadSummary(verdict, originLabel, destLabel, distanceKm, alerts, workZones),
      },
      weather: {
        active_alerts: alerts.slice(0, MAX_REPORTED_EVENTS),
        total_alerts: alerts.length,
        counts_by_severity: {
          extreme: alerts.filter((a) => a.severity === "Extreme").length,
          severe: alerts.filter((a) => a.severity === "Severe").length,
          moderate: alerts.filter((a) => a.severity === "Moderate").length,
          minor: alerts.filter((a) => a.severity === "Minor").length,
        },
      },
      work_zones: {
        total_on_corridor: workZones.length,
        all_lanes_closed: workZones.filter((w) => w.vehicle_impact === "all-lanes-closed").length,
        some_lanes_closed: workZones.filter((w) => w.vehicle_impact === "some-lanes-closed").length,
        corridor_buffer_km: CORRIDOR_BUFFER_KM,
        events: workZones.slice(0, MAX_REPORTED_EVENTS),
      },
      coverage: {
        nws: `nationwide; ${okSamples}/${corridor.length} corridor samples reachable`,
        wzdx: {
          states_crossed: stateNames,
          states_with_live_feed: okFeedStates,
          states_without_public_feed: statesWithoutFeed,
          feeds_failed_this_read: feedsFailed,
          note:
            "WZDx coverage only exists where a state DOT publishes a keyless feed; " +
            "states without one are listed, not silently faked.",
        },
      },
      data_quality: {
        stale_sources: staleSources,
        computed_at: now.toISOString(),
        sources: {
          nws: "api.weather.gov (live, 5-min point cache)",
          wzdx_registry: "data.transportation.gov 69qe-yiui (24h cache)",
          geocoder: "nominatim (30d cache; skipped for lat,lon inputs)",
        },
      },
    },
  };
};
