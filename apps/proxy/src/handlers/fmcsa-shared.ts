/**
 * fmcsa-shared.ts — shared plumbing for the freight vetting endpoints
 * (carrier-risk-verdict, broker-authority-check).
 *
 * Two data planes:
 *   1. Postgres mirror of the FMCSA Motus "All With History" datasets
 *      (fmcsa_insur / fmcsa_inshist / fmcsa_authhist / fmcsa_revoke /
 *      fmcsa_boc3 / fmcsa_carrier), refreshed daily by
 *      scripts/freight/ingest-fmcsa.mjs. Always local, always fast.
 *   2. Live per-DOT Socrata lookups for the two files too big to mirror:
 *      census az4n-8mr2 (4.47M rows) and inspections fx4q-ay7w (8.3M).
 *      Cached in fmcsa_census_cache / fmcsa_inspection_cache with
 *      stale-if-error fallback; every census read also lands in
 *      fmcsa_census_snapshots to accumulate the MCS-150 time series
 *      (fleet-jump fraud signal grows real history over time).
 *
 * FMCSA data is public domain (US government work). Responses MUST
 * carry SMS_DISCLAIMER wording; FAST Act §5223 masks property-carrier
 * BASIC percentiles, so we expose raw inspection counts and our own
 * derived score — never "CSA scores".
 */
import type { DbQuerier } from "./types.js";

export const SODA_BASE = "https://data.transportation.gov/resource";
export const CENSUS_DATASET = "az4n-8mr2";
export const INSPECTION_DATASET = "fx4q-ay7w";

const SODA_TIMEOUT_MS = 10_000;

/**
 * FMCSA's required wording for products derived from SMS/safety data
 * (paraphrase of the SMS Data Disclaimer, plus the FAST Act masking
 * note that applies to everything downstream of ai.fmcsa.dot.gov).
 */
export const SMS_DISCLAIMER =
  "Readers should not draw conclusions about a carrier's overall safety " +
  "condition simply based on the data displayed here. Unless a carrier " +
  "has received an UNSATISFACTORY safety rating under 49 CFR Part 385 or " +
  "has otherwise been ordered to discontinue operations by FMCSA, it is " +
  "authorized to operate on the nation's roadways. This verdict is a " +
  "SuVerse-derived risk assessment computed from public FMCSA data; it " +
  "is not an FMCSA safety rating and not a CSA/SMS score. Property-carrier " +
  "BASIC percentiles are excluded from public data by the FAST Act.";

// ─────────────────────────────────────────────────────────────────────
// Identifier normalization
// ─────────────────────────────────────────────────────────────────────

/**
 * "MC-424836" / "mc 424836" / "424836" → "MC424836".
 * Bare digits get the MC prefix; FF/MX prefixes are preserved.
 */
export function normalizeDocket(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^\d{1,8}$/.test(cleaned)) return `MC${cleaned}`;
  if (/^(MC|FF|MX)\d{1,8}$/.test(cleaned)) return cleaned;
  return null;
}

export function normalizeDot(input: string): string | null {
  const cleaned = input.trim().replace(/^USDOT[\s#:-]*/i, "").replace(/\s/g, "");
  if (!/^\d{1,9}$/.test(cleaned)) return null;
  // Census / Motus store DOT numbers without leading zeros.
  return String(Number(cleaned));
}

// ─────────────────────────────────────────────────────────────────────
// Socrata live fetch (per-DOT) with Postgres cache + stale-if-error
// ─────────────────────────────────────────────────────────────────────

export async function sodaFetch(
  fetchImpl: typeof fetch,
  datasetId: string,
  params: Record<string, string>,
): Promise<unknown[]> {
  const url = new URL(`${SODA_BASE}/${datasetId}.json`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = { accept: "application/json" };
  const token = process.env["SOCRATA_APP_TOKEN"];
  if (token) headers["X-App-Token"] = token;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SODA_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url.toString(), {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`socrata_${datasetId}_status_${res.status}`);
    const data: unknown = await res.json();
    if (!Array.isArray(data)) throw new Error(`socrata_${datasetId}_bad_shape`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const CACHE_FRESH_MS = 24 * 3_600_000;
const CACHE_STALE_MAX_MS = 7 * 86_400_000;

export interface CachedLookup<T> {
  value: T;
  /** live | cache (fresh) | stale_cache (upstream down, old data served) */
  source: "live" | "cache" | "stale_cache";
  fetchedAt: Date;
}

interface CacheRow {
  payload: unknown;
  fetched_at: Date | string;
}

async function readCache(
  db: DbQuerier,
  table: "fmcsa_census_cache" | "fmcsa_inspection_cache",
  dot: string,
): Promise<CacheRow | null> {
  const { rows } = await db.query(
    `SELECT payload, fetched_at FROM ${table} WHERE dot_number = $1`,
    [dot],
  );
  return rows.length > 0 ? (rows[0] as unknown as CacheRow) : null;
}

async function writeCache(
  db: DbQuerier,
  table: "fmcsa_census_cache" | "fmcsa_inspection_cache",
  dot: string,
  payload: unknown,
): Promise<void> {
  await db.query(
    `INSERT INTO ${table} (dot_number, payload, fetched_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (dot_number) DO UPDATE
       SET payload = EXCLUDED.payload, fetched_at = EXCLUDED.fetched_at`,
    [dot, JSON.stringify(payload)],
  );
}

/**
 * Cache-or-live lookup: fresh cache (<24h) short-circuits; otherwise go
 * live and refresh the cache; if live fails, serve cache up to 7 days
 * old flagged as stale_cache. Throws only when live fails AND no
 * usable cache exists — callers fail closed on that.
 */
async function cachedLookup<T>(
  db: DbQuerier,
  table: "fmcsa_census_cache" | "fmcsa_inspection_cache",
  dot: string,
  live: () => Promise<T>,
): Promise<CachedLookup<T>> {
  const cached = await readCache(db, table, dot).catch(() => null);
  const age =
    cached === null ? Infinity : Date.now() - new Date(cached.fetched_at).getTime();
  if (cached !== null && age < CACHE_FRESH_MS) {
    return {
      value: cached.payload as T,
      source: "cache",
      fetchedAt: new Date(cached.fetched_at),
    };
  }
  try {
    const value = await live();
    await writeCache(db, table, dot, value).catch(() => {});
    return { value, source: "live", fetchedAt: new Date() };
  } catch (err) {
    if (cached !== null && age < CACHE_STALE_MAX_MS) {
      return {
        value: cached.payload as T,
        source: "stale_cache",
        fetchedAt: new Date(cached.fetched_at),
      };
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Census (identity + MCS-150 fraud-signal fields)
// ─────────────────────────────────────────────────────────────────────

/** The census columns the verdict actually uses (of ~50 available). */
export interface CensusRow {
  dot_number: string;
  legal_name: string | null;
  dba_name: string | null;
  status_code: string | null;
  carrier_operation: string | null;
  phy_city: string | null;
  phy_state: string | null;
  phy_country: string | null;
  power_units: number | null;
  truck_units: number | null;
  total_drivers: number | null;
  total_cdl: number | null;
  mcs150_date: string | null;
  mcs150_mileage: number | null;
  mcs150_mileage_year: string | null;
  add_date: string | null;
  undeliv_phy: string | null;
  [k: string]: unknown;
}

function toInt(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : null;
}
function toStr(v: unknown): string | null {
  return v === null || v === undefined || v === "" ? null : String(v);
}
/** pg returns DATE columns as JS Date objects; SoQL returns strings. */
function toIsoDate(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

export function parseCensusRow(raw: Record<string, unknown>): CensusRow {
  return {
    dot_number: String(raw["dot_number"] ?? ""),
    legal_name: toStr(raw["legal_name"]),
    dba_name: toStr(raw["dba_name"]),
    status_code: toStr(raw["status_code"]),
    carrier_operation: toStr(raw["carrier_operation"]),
    phy_city: toStr(raw["phy_city"]),
    phy_state: toStr(raw["phy_state"]),
    phy_country: toStr(raw["phy_country"]),
    power_units: toInt(raw["power_units"]),
    truck_units: toInt(raw["truck_units"]),
    total_drivers: toInt(raw["total_drivers"]),
    total_cdl: toInt(raw["total_cdl"]),
    mcs150_date: toStr(raw["mcs150_date"]),
    mcs150_mileage: toInt(raw["mcs150_mileage"]),
    mcs150_mileage_year: toStr(raw["mcs150_mileage_year"]),
    add_date: toStr(raw["add_date"]),
    undeliv_phy: toStr(raw["undeliv_phy"]),
  };
}

/** null value = DOT genuinely absent from the census (carrier not found). */
export async function fetchCensusByDot(
  db: DbQuerier,
  fetchImpl: typeof fetch,
  dot: string,
): Promise<CachedLookup<CensusRow | null>> {
  return cachedLookup(db, "fmcsa_census_cache", dot, async () => {
    const rows = await sodaFetch(fetchImpl, CENSUS_DATASET, {
      dot_number: dot,
      $limit: "1",
    });
    return rows.length > 0
      ? parseCensusRow(rows[0] as Record<string, unknown>)
      : null;
  });
}

export interface NameCandidate {
  dot_number: string;
  legal_name: string | null;
  dba_name: string | null;
  phy_city: string | null;
  phy_state: string | null;
  power_units: number | null;
}

/** Live-only name search (no caching — free-text keys don't cache well). */
export async function searchCensusByName(
  fetchImpl: typeof fetch,
  name: string,
  limit = 10,
): Promise<NameCandidate[]> {
  const needle = name.toUpperCase().replace(/'/g, "''").trim();
  const rows = await sodaFetch(fetchImpl, CENSUS_DATASET, {
    $where: `(upper(legal_name) LIKE '%${needle}%' OR upper(dba_name) LIKE '%${needle}%')`,
    $order: "power_units DESC",
    $limit: String(limit),
  });
  return rows.map((r) => {
    const c = parseCensusRow(r as Record<string, unknown>);
    return {
      dot_number: c.dot_number,
      legal_name: c.legal_name,
      dba_name: c.dba_name,
      phy_city: c.phy_city,
      phy_state: c.phy_state,
      power_units: c.power_units,
    };
  });
}

/**
 * Write today's census snapshot (idempotent per day) and return the
 * accumulated MCS-150 series for fleet-jump detection.
 */
export interface CensusSnapshot {
  snapshot_date: string;
  power_units: number | null;
  total_drivers: number | null;
  mcs150_date: string | null;
  mcs150_mileage: number | null;
}

export async function snapshotCensus(
  db: DbQuerier,
  dot: string,
  row: CensusRow,
): Promise<CensusSnapshot[]> {
  await db
    .query(
      `INSERT INTO fmcsa_census_snapshots
         (dot_number, snapshot_date, power_units, total_drivers, mcs150_date, mcs150_mileage, payload)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)
       ON CONFLICT (dot_number, snapshot_date) DO NOTHING`,
      [
        dot,
        row.power_units,
        row.total_drivers,
        row.mcs150_date,
        row.mcs150_mileage,
        JSON.stringify(row),
      ],
    )
    .catch(() => {});
  const { rows } = await db.query(
    `SELECT snapshot_date, power_units, total_drivers, mcs150_date, mcs150_mileage
       FROM fmcsa_census_snapshots
      WHERE dot_number = $1
      ORDER BY snapshot_date ASC`,
    [dot],
  );
  return rows.map((r) => ({
    snapshot_date: toIsoDate(r["snapshot_date"])!,
    power_units: toInt(r["power_units"]),
    total_drivers: toInt(r["total_drivers"]),
    mcs150_date: toStr(r["mcs150_date"]),
    mcs150_mileage: toInt(r["mcs150_mileage"]),
  }));
}

// ─────────────────────────────────────────────────────────────────────
// Inspections (24-month per-DOT summary, live + cached)
// ─────────────────────────────────────────────────────────────────────

export interface InspectionSummary {
  window_months: number;
  inspection_count: number;
  violation_total: number;
  oos_total: number;
  driver_oos_total: number;
  vehicle_oos_total: number;
  driver_oos_rate: number | null;
  vehicle_oos_rate: number | null;
  last_inspection_date: string | null;
}

const INSPECTION_WINDOW_MONTHS = 24;

export async function fetchInspectionSummary(
  db: DbQuerier,
  fetchImpl: typeof fetch,
  dot: string,
  now: Date,
): Promise<CachedLookup<InspectionSummary>> {
  return cachedLookup(db, "fmcsa_inspection_cache", dot, async () => {
    const since = new Date(now.getTime());
    since.setMonth(since.getMonth() - INSPECTION_WINDOW_MONTHS);
    const sinceYmd = since.toISOString().slice(0, 10).replace(/-/g, "");
    const rows = await sodaFetch(fetchImpl, INSPECTION_DATASET, {
      // The count columns are typed text in Socrata — cast before sum.
      $select:
        "count(*) AS insp_count, sum(viol_total::number) AS viol_total," +
        "sum(oos_total::number) AS oos_total, sum(driver_oos_total::number) AS driver_oos," +
        "sum(vehicle_oos_total::number) AS vehicle_oos, max(insp_date) AS last_insp",
      $where: `dot_number = '${dot}' AND insp_date >= '${sinceYmd}'`,
    });
    const r = (rows[0] ?? {}) as Record<string, unknown>;
    const inspCount = toInt(r["insp_count"]) ?? 0;
    const driverOos = toInt(r["driver_oos"]) ?? 0;
    const vehicleOos = toInt(r["vehicle_oos"]) ?? 0;
    const lastRaw = toStr(r["last_insp"]);
    return {
      window_months: INSPECTION_WINDOW_MONTHS,
      inspection_count: inspCount,
      violation_total: toInt(r["viol_total"]) ?? 0,
      oos_total: toInt(r["oos_total"]) ?? 0,
      driver_oos_total: driverOos,
      vehicle_oos_total: vehicleOos,
      driver_oos_rate: inspCount > 0 ? round3(driverOos / inspCount) : null,
      vehicle_oos_rate: inspCount > 0 ? round3(vehicleOos / inspCount) : null,
      last_inspection_date:
        lastRaw !== null && /^\d{8}$/.test(lastRaw)
          ? `${lastRaw.slice(0, 4)}-${lastRaw.slice(4, 6)}-${lastRaw.slice(6, 8)}`
          : lastRaw,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────
// Motus mirror queries (local Postgres, docket-keyed)
// ─────────────────────────────────────────────────────────────────────

export interface AuthorityStatus {
  op_auth_type: string;
  op_auth_status: string;
  reason: string | null;
  status_change_date: string | null;
}

/** Latest AuthHist event per authority type = current status ladder. */
export async function latestAuthorityByType(
  db: DbQuerier,
  docketNorm: string,
): Promise<AuthorityStatus[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (op_auth_type)
            op_auth_type, op_auth_status, reason, status_change_date
       FROM fmcsa_authhist
      WHERE docket_norm = $1 AND op_auth_type IS NOT NULL
      ORDER BY op_auth_type, status_change_date DESC NULLS LAST`,
    [docketNorm],
  );
  return rows.map((r) => ({
    op_auth_type: String(r["op_auth_type"]),
    op_auth_status: String(r["op_auth_status"] ?? "Unknown"),
    reason: toStr(r["reason"]),
    status_change_date: toIsoDate(r["status_change_date"]),
  }));
}

/** Earliest GRANT date across authority types — the authority age anchor. */
export async function earliestGrantDate(
  db: DbQuerier,
  docketNorm: string,
): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT MIN(status_change_date) AS first_grant
       FROM fmcsa_authhist
      WHERE docket_norm = $1 AND op_auth_status = 'Active'`,
    [docketNorm],
  );
  const v = rows[0]?.["first_grant"];
  return toIsoDate(v);
}

export interface AuthorityEvent extends AuthorityStatus {}

/** Full authority event history (revocations, reinstatements, grants). */
export async function authorityHistory(
  db: DbQuerier,
  docketNorm: string,
  limit = 50,
): Promise<AuthorityEvent[]> {
  const { rows } = await db.query(
    `SELECT op_auth_type, op_auth_status, reason, status_change_date
       FROM fmcsa_authhist
      WHERE docket_norm = $1
      ORDER BY status_change_date DESC NULLS LAST
      LIMIT $2`,
    [docketNorm, limit],
  );
  return rows.map((r) => ({
    op_auth_type: String(r["op_auth_type"] ?? "Unknown"),
    op_auth_status: String(r["op_auth_status"] ?? "Unknown"),
    reason: toStr(r["reason"]),
    status_change_date: toIsoDate(r["status_change_date"]),
  }));
}

export interface SuspensionOrder {
  op_auth_type: string | null;
  order_type: string | null;
  serve_date: string | null;
  effective_date: string | null;
}

export async function suspensionOrders(
  db: DbQuerier,
  docketNorm: string,
): Promise<SuspensionOrder[]> {
  const { rows } = await db.query(
    `SELECT op_auth_type, order1_type_desc, order1_serve_date, order1_effective_date
       FROM fmcsa_revoke
      WHERE docket_norm = $1
      ORDER BY order1_serve_date DESC NULLS LAST`,
    [docketNorm],
  );
  return rows.map((r) => ({
    op_auth_type: toStr(r["op_auth_type"]),
    order_type: toStr(r["order1_type_desc"]),
    serve_date: toIsoDate(r["order1_serve_date"]),
    effective_date: toIsoDate(r["order1_effective_date"]),
  }));
}

export interface InsuranceFiling {
  form: string | null;
  type: "BIPD" | "CARGO" | "SURETY" | "TRUST_FUND" | "OTHER";
  max_coverage_usd: number | null;
  underlying_limit_usd: number | null;
  policy_no: string | null;
  effective_date: string | null;
  insurer: string | null;
}

const INS_TYPE_BY_CODE: Record<string, InsuranceFiling["type"]> = {
  "1": "BIPD",
  "2": "CARGO",
  "3": "SURETY",
  "4": "TRUST_FUND",
};

/** Deduped active/pending filings on file (Motus Insur, docket-keyed). */
export async function insuranceOnFile(
  db: DbQuerier,
  docketNorm: string,
): Promise<InsuranceFiling[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT ins_form_code, ins_type_code, max_cov_amount,
            underl_lim_amount, policy_no, effective_date, insurance_company_name
       FROM fmcsa_insur
      WHERE docket_norm = $1
      ORDER BY effective_date DESC NULLS LAST
      LIMIT 40`,
    [docketNorm],
  );
  return rows.map((r) => ({
    form: toStr(r["ins_form_code"]),
    type: INS_TYPE_BY_CODE[String(r["ins_type_code"] ?? "")] ?? "OTHER",
    max_coverage_usd: r["max_cov_amount"] === null ? null : Number(r["max_cov_amount"]),
    underlying_limit_usd:
      r["underl_lim_amount"] === null ? null : Number(r["underl_lim_amount"]),
    policy_no: toStr(r["policy_no"]),
    effective_date: toIsoDate(r["effective_date"]),
    insurer: toStr(r["insurance_company_name"]),
  }));
}

export interface CarrierRegRow {
  docket_number: string | null;
  usdot_number: string | null;
  op_auth_type: string | null;
  op_auth_status: string | null;
  legal_name: string | null;
  dba_name: string | null;
  min_cov_amount: number | null;
  cargo_req: string | null;
  bond_req: string | null;
  bipd_file: string | null;
  cargo_file: string | null;
  bond_file: string | null;
  bus_undeliverable_mail: string | null;
  mail_undeliverable_mail: string | null;
  bus_city: string | null;
  bus_state_code: string | null;
}

/** Motus Carrier registration rows (one per authority type). */
export async function carrierRegistration(
  db: DbQuerier,
  key: { docketNorm?: string; dot?: string },
): Promise<CarrierRegRow[]> {
  const byDocket = key.docketNorm !== undefined;
  const { rows } = await db.query(
    `SELECT docket_number, usdot_number, op_auth_type, op_auth_status,
            legal_name, dba_name, min_cov_amount, cargo_req, bond_req,
            bipd_file, cargo_file, bond_file,
            bus_undeliverable_mail, mail_undeliverable_mail,
            bus_city, bus_state_code
       FROM fmcsa_carrier
      WHERE ${byDocket ? "docket_norm = $1" : "usdot_number = $1"}`,
    [byDocket ? key.docketNorm : key.dot],
  );
  return rows.map((r) => ({
    docket_number: toStr(r["docket_number"]),
    usdot_number: toStr(r["usdot_number"]),
    op_auth_type: toStr(r["op_auth_type"]),
    op_auth_status: toStr(r["op_auth_status"]),
    legal_name: toStr(r["legal_name"]),
    dba_name: toStr(r["dba_name"]),
    min_cov_amount: r["min_cov_amount"] === null ? null : Number(r["min_cov_amount"]),
    cargo_req: toStr(r["cargo_req"]),
    bond_req: toStr(r["bond_req"]),
    bipd_file: toStr(r["bipd_file"]),
    cargo_file: toStr(r["cargo_file"]),
    bond_file: toStr(r["bond_file"]),
    bus_undeliverable_mail: toStr(r["bus_undeliverable_mail"]),
    mail_undeliverable_mail: toStr(r["mail_undeliverable_mail"]),
    bus_city: toStr(r["bus_city"]),
    bus_state_code: toStr(r["bus_state_code"]),
  }));
}

export interface Boc3Row {
  co_name: string | null;
  city: string | null;
  state_code: string | null;
}

export async function boc3OnFile(
  db: DbQuerier,
  docketNorm: string,
): Promise<Boc3Row | null> {
  const { rows } = await db.query(
    `SELECT co_name, city, state_code FROM fmcsa_boc3
      WHERE docket_norm = $1 LIMIT 1`,
    [docketNorm],
  );
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    co_name: toStr(r["co_name"]),
    city: toStr(r["city"]),
    state_code: toStr(r["state_code"]),
  };
}

/** Map a docket to its DOT (any Motus table carries the pair). */
export async function dotForDocket(
  db: DbQuerier,
  docketNorm: string,
): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT usdot_number FROM fmcsa_carrier WHERE docket_norm = $1 AND usdot_number IS NOT NULL
     UNION
     SELECT usdot_number FROM fmcsa_authhist WHERE docket_norm = $1 AND usdot_number IS NOT NULL
     UNION
     SELECT usdot_number FROM fmcsa_insur WHERE docket_norm = $1 AND usdot_number IS NOT NULL
     LIMIT 1`,
    [docketNorm],
  );
  return rows.length > 0 ? toStr(rows[0]!["usdot_number"]) : null;
}

/** All dockets registered under a DOT. */
export async function docketsForDot(
  db: DbQuerier,
  dot: string,
): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT docket_norm FROM (
       SELECT docket_norm FROM fmcsa_carrier WHERE usdot_number = $1
       UNION
       SELECT docket_norm FROM fmcsa_authhist WHERE usdot_number = $1
       UNION
       SELECT docket_norm FROM fmcsa_insur WHERE usdot_number = $1
     ) d WHERE docket_norm IS NOT NULL`,
    [dot],
  );
  return rows.map((r) => String(r["docket_norm"])).sort();
}

// ─────────────────────────────────────────────────────────────────────
// Mirror freshness (fmcsa_ingest_runs) — disclosed in data_quality
// ─────────────────────────────────────────────────────────────────────

export interface MirrorFreshness {
  dataset: string;
  ingested_at: string;
  extract_max_date: string | null;
}

export async function mirrorFreshness(db: DbQuerier): Promise<MirrorFreshness[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (dataset) dataset, finished_at, max_date
       FROM fmcsa_ingest_runs
      WHERE status = 'ok'
      ORDER BY dataset, started_at DESC`,
  );
  return rows.map((r) => ({
    dataset: String(r["dataset"]),
    ingested_at: new Date(String(r["finished_at"])).toISOString(),
    extract_max_date: toStr(r["max_date"]),
  }));
}

/** Fail-closed guard: the mirror must exist and be under 8 days old. */
export const MIRROR_MAX_AGE_MS = 8 * 86_400_000;

export function mirrorIsUsable(fresh: MirrorFreshness[], now: Date): boolean {
  const core = ["fmcsa_insur", "fmcsa_authhist", "fmcsa_carrier"];
  return core.every((ds) => {
    const row = fresh.find((f) => f.dataset === ds);
    return (
      row !== undefined &&
      now.getTime() - new Date(row.ingested_at).getTime() < MIRROR_MAX_AGE_MS
    );
  });
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
