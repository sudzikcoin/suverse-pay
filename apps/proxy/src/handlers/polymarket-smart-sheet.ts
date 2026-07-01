/**
 * polymarket-smart-sheet — ONE call, ONE ranked table of every active
 * Polymarket market where tracked smart money currently has an edge.
 * $0.75 buys the joined view of all four Polymarket Smart Money
 * endpoints the catalog sells separately:
 *
 *   smart-bias        — CRITICAL. The sheet's spine: per-market
 *                       bias/conviction from poly_smart_bias_cache.
 *   whale-entries     — enrichment. Large BUYs in the window, rolled
 *                       up per market (count / net USD / dominant side).
 *   trader-skill      — enrichment. Skill ranking joined to the whale
 *                       entrants via trader_address_hash.
 *   position-holders  — enrichment, top-5 markets by |bias| ONLY
 *                       (holder concentration is the expensive stock
 *                       signal; capped at 5 sequential upstream calls).
 *
 * Fail-closed: the sheet is impossible without smart-bias, so the
 * preflight proves it BEFORE the payment settles — a down/invalid
 * critical source is a 503 and the buyer is NOT charged. The three
 * enrichment sources degrade: a failure is noted in
 * `data_quality.stale_sources` and the row field comes back null.
 *
 * Privacy: the Polymarket service never exposes raw trader addresses
 * (18-char trader_address_hash only) and position-holders is
 * aggregates-only. This handler joins on those hashes and re-exposes
 * NOTHING beyond what the four routes already return.
 *
 * Input is fully optional — an empty/garbage body IS the product
 * default (the full sheet). Present-but-wrong-typed fields are the
 * only 422.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerPreflight,
  InternalHandlerResult,
  InternalHandlerValidator,
} from "./types.js";
import { isPlaceholderValue, type InternalHandlerInputSchema } from "./discovery.js";

// ─────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────

const SHEET_LIMIT_MIN = 1;
const SHEET_LIMIT_MAX = 50;
const SHEET_LIMIT_DEFAULT = 20;

/** Enums mirrored from the smart-bias route's zod schema. */
const CATEGORIES = ["politics", "crypto", "sports", "macro", "other", "all"] as const;
const TIME_WINDOWS = ["1h", "24h", "7d", "30d"] as const;
export type SheetCategory = (typeof CATEGORIES)[number];
export type SheetTimeWindow = (typeof TIME_WINDOWS)[number];

/** Widest sheet the upstream allows (smart-bias limit is 1..100). */
const BIAS_FETCH_LIMIT = 100;
/** Upstream caps for the enrichment fan-out. */
const WHALE_FETCH_LIMIT = 100;
const SKILL_FETCH_LIMIT = 100;
const HOLDERS_FETCH_LIMIT = 100;
/** Position-holders: top-N markets by |bias| get holder concentration. */
const POSITION_HOLDERS_TOP_N = 5;
/** Hard cap on sequential position-holders upstream calls. */
const POSITION_HOLDERS_MAX_CALLS = 5;
/** Row-level confidence buckets from upstream conviction_score. */
const CONVICTION_HIGH = 60;
const CONVICTION_MEDIUM = 30;

const UPSTREAM_TIMEOUT_MS = 10_000;
/** Per-object byte cap for the raw layer (no full source dumps). */
const RAW_CAP_BYTES = 2_048;

function polymarketApiBase(): string {
  return process.env["POLYMARKET_API_URL"] ?? "http://127.0.0.1:3400";
}

// ─────────────────────────────────────────────────────────────────────
// Input parsing — every field optional; garbage bodies mean "defaults".
// ─────────────────────────────────────────────────────────────────────

export interface SheetOptions {
  limit: number;
  category: SheetCategory;
  timeWindow: SheetTimeWindow;
}

export type SheetParse =
  | { kind: "ok"; opts: SheetOptions }
  | { kind: "invalid_field"; error: string; detail: string };

const DEFAULT_OPTS: SheetOptions = {
  limit: SHEET_LIMIT_DEFAULT,
  category: "all",
  timeWindow: "24h",
};

/**
 * Empty / non-JSON / non-object bodies → defaults (the loyal-buyer
 * contract: garbage in, full sheet out). A present field with a real
 * but wrong-typed / out-of-enum value → invalid_field (422 upstream);
 * placeholder strings from schema-blind probes are ignored. limit is
 * CLAMPED into 1..50, never rejected for range.
 */
export function parseSheetBody(body: Buffer | null): SheetParse {
  if (!body || body.length === 0 || body.toString("utf8").trim() === "") {
    return { kind: "ok", opts: { ...DEFAULT_OPTS } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { kind: "ok", opts: { ...DEFAULT_OPTS } };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "ok", opts: { ...DEFAULT_OPTS } };
  }
  const obj = parsed as Record<string, unknown>;
  const opts: SheetOptions = { ...DEFAULT_OPTS };

  const rawLimit = obj["limit"];
  if (rawLimit !== undefined && rawLimit !== null) {
    if (typeof rawLimit === "number" && Number.isFinite(rawLimit)) {
      opts.limit = Math.min(
        SHEET_LIMIT_MAX,
        Math.max(SHEET_LIMIT_MIN, Math.floor(rawLimit)),
      );
    } else if (!(typeof rawLimit === "string" && isPlaceholderValue(rawLimit))) {
      return {
        kind: "invalid_field",
        error: "invalid_limit",
        detail: "limit must be a number; values are clamped into 1..50",
      };
    }
  }

  const rawCategory = obj["category"];
  if (rawCategory !== undefined && rawCategory !== null) {
    if (typeof rawCategory !== "string") {
      return {
        kind: "invalid_field",
        error: "invalid_category",
        detail: `category must be one of ${CATEGORIES.join("|")}`,
      };
    }
    if (!isPlaceholderValue(rawCategory)) {
      const c = rawCategory.trim().toLowerCase();
      if (!(CATEGORIES as readonly string[]).includes(c)) {
        return {
          kind: "invalid_field",
          error: "invalid_category",
          detail: `category must be one of ${CATEGORIES.join("|")}`,
        };
      }
      opts.category = c as SheetCategory;
    }
  }

  const rawWindow = obj["time_window"];
  if (rawWindow !== undefined && rawWindow !== null) {
    if (typeof rawWindow !== "string") {
      return {
        kind: "invalid_field",
        error: "invalid_time_window",
        detail: `time_window must be one of ${TIME_WINDOWS.join("|")}`,
      };
    }
    if (!isPlaceholderValue(rawWindow)) {
      const w = rawWindow.trim().toLowerCase();
      if (!(TIME_WINDOWS as readonly string[]).includes(w)) {
        return {
          kind: "invalid_field",
          error: "invalid_time_window",
          detail: `time_window must be one of ${TIME_WINDOWS.join("|")}`,
        };
      }
      opts.timeWindow = w as SheetTimeWindow;
    }
  }

  return { kind: "ok", opts };
}

export const polymarketSmartSheetInputSchema: InternalHandlerInputSchema = {
  method: "POST",
  content_type: "application/json",
  body: {
    type: "object",
    required: [],
    properties: {
      limit: {
        type: "integer",
        description:
          "Rows in the returned sheet, 1-50 (default 20). Out-of-range values are clamped, never rejected.",
      },
      category: {
        type: "string",
        description:
          "Optional market category filter (default all).",
        pattern: "^(politics|crypto|sports|macro|other|all)$",
      },
      time_window: {
        type: "string",
        description:
          "Smart-bias aggregation window (default 24h).",
        pattern: "^(1h|24h|7d|30d)$",
      },
    },
  },
  example: { limit: 20, category: "all", time_window: "24h" },
};

export const polymarketSmartSheetValidator: InternalHandlerValidator = (
  body,
  _method,
) => {
  const p = parseSheetBody(body);
  if (p.kind === "ok") return null;
  return {
    status: 422,
    body: {
      error: p.error,
      detail: p.detail,
      input_schema: polymarketSmartSheetInputSchema,
    },
  };
};

// ─────────────────────────────────────────────────────────────────────
// Upstream shapes — structural, only the fields we read.
// ─────────────────────────────────────────────────────────────────────

export interface BiasMarket {
  market_id: string;
  market_title?: string | null;
  category?: string;
  bias_score?: number;
  conviction_score?: number;
  smart_yes_volume_usd?: number;
  smart_no_volume_usd?: number;
  [k: string]: unknown;
}

export interface BiasResponse {
  data: BiasMarket[];
  meta: Record<string, unknown>;
}

export interface WhaleEntry {
  market_id?: string;
  trader_address_hash?: string;
  side?: string;
  size_usd?: number;
  [k: string]: unknown;
}

export interface WhaleResponse {
  data: WhaleEntry[];
  meta: Record<string, unknown>;
}

export interface SkillTrader {
  trader_address_hash?: string;
  rank?: number;
  overall_skill_score?: number;
  tier?: string;
  [k: string]: unknown;
}

export interface SkillResponse {
  data: SkillTrader[];
}

export interface HoldersItem {
  market_id?: string;
  side_dominant?: string;
  skilled_holders_count_yes?: number;
  skilled_holders_count_no?: number;
  total_value_usd_combined?: number;
  yes_position_concentration?: number | null;
  largest_position_usd?: number;
  conviction_score?: number;
  [k: string]: unknown;
}

export type SourceResult<T> = { ok: true; data: T } | { ok: false; error: string };

// ─────────────────────────────────────────────────────────────────────
// Source fetchers — all POST to the Polymarket service, 10s timeout.
// ─────────────────────────────────────────────────────────────────────

async function postJson(
  input: InternalHandlerInput,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${polymarketApiBase()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`status_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSmartBias(
  input: InternalHandlerInput,
  category: SheetCategory,
  timeWindow: SheetTimeWindow,
): Promise<SourceResult<BiasResponse>> {
  try {
    const raw = (await postJson(input, "/v1/polymarket/smart-bias", {
      category,
      time_window: timeWindow,
      limit: BIAS_FETCH_LIMIT,
    })) as { data?: unknown; meta?: unknown };
    if (!Array.isArray(raw.data)) {
      return { ok: false, error: "smart_bias_bad_shape" };
    }
    const meta =
      typeof raw.meta === "object" && raw.meta !== null
        ? (raw.meta as Record<string, unknown>)
        : {};
    return { ok: true, data: { data: raw.data as BiasMarket[], meta } };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? "smart_bias_unreachable" };
  }
}

async function fetchWhaleEntries(
  input: InternalHandlerInput,
  category: SheetCategory,
  timeWindow: SheetTimeWindow,
): Promise<SourceResult<WhaleResponse>> {
  try {
    const raw = (await postJson(input, "/v1/polymarket/whale-entries", {
      // whale-entries only knows 1h|6h|24h — anything wider maps to 24h.
      time_window: timeWindow === "1h" ? "1h" : "24h",
      category,
      limit: WHALE_FETCH_LIMIT,
    })) as { data?: unknown; meta?: unknown };
    if (!Array.isArray(raw.data)) {
      return { ok: false, error: "whale_entries_bad_shape" };
    }
    const meta =
      typeof raw.meta === "object" && raw.meta !== null
        ? (raw.meta as Record<string, unknown>)
        : {};
    return { ok: true, data: { data: raw.data as WhaleEntry[], meta } };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? "whale_entries_unreachable" };
  }
}

async function fetchTraderSkill(
  input: InternalHandlerInput,
  category: SheetCategory,
): Promise<SourceResult<SkillResponse>> {
  try {
    const raw = (await postJson(input, "/v1/polymarket/trader-skill", {
      // trader-skill's category enum swaps "all" for "overall".
      category: category === "all" ? "overall" : category,
      limit: SKILL_FETCH_LIMIT,
    })) as { data?: unknown };
    if (!Array.isArray(raw.data)) {
      return { ok: false, error: "trader_skill_bad_shape" };
    }
    return { ok: true, data: { data: raw.data as SkillTrader[] } };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? "trader_skill_unreachable" };
  }
}

async function fetchPositionHolders(
  input: InternalHandlerInput,
  category: SheetCategory,
): Promise<SourceResult<HoldersItem[]>> {
  try {
    const raw = (await postJson(input, "/v1/polymarket/position-holders", {
      category,
      // widest join surface the route allows.
      min_skilled_holders: 1,
      min_total_position_usd: 100,
      limit: HOLDERS_FETCH_LIMIT,
    })) as { data?: unknown };
    if (!Array.isArray(raw.data)) {
      return { ok: false, error: "position_holders_bad_shape" };
    }
    return { ok: true, data: raw.data as HoldersItem[] };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message ?? "position_holders_unreachable",
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Critical source + preflight (fail-closed gate)
// ─────────────────────────────────────────────────────────────────────

interface SheetCritical {
  kind: "polymarket_smart_sheet_critical";
  category: SheetCategory;
  timeWindow: SheetTimeWindow;
  bias: BiasResponse;
}

function isSheetCritical(v: unknown): v is SheetCritical {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as SheetCritical).kind === "polymarket_smart_sheet_critical"
  );
}

/**
 * Proves smart-bias (the sheet's spine) is up AND well-shaped BEFORE
 * the payment settles; threads the full bias response through as
 * preflightData so the handler never re-fetches the critical source.
 */
export const polymarketSmartSheetPreflight: InternalHandlerPreflight = async (
  input,
) => {
  const parsed = parseSheetBody(input.body);
  if (parsed.kind !== "ok") {
    // Defensive: the validator already 422s this pre-challenge.
    return {
      proceed: false,
      status: 422,
      body: {
        error: parsed.error,
        detail: parsed.detail,
        input_schema: polymarketSmartSheetInputSchema,
      },
    };
  }
  const bias = await fetchSmartBias(
    input,
    parsed.opts.category,
    parsed.opts.timeWindow,
  );
  if (!bias.ok) {
    return {
      proceed: false,
      status: 503,
      body: {
        error: "critical_source_unavailable",
        source: "smart_bias",
        detail: bias.error,
        retryable: true,
      },
    };
  }
  return {
    proceed: true,
    data: {
      kind: "polymarket_smart_sheet_critical",
      category: parsed.opts.category,
      timeWindow: parsed.opts.timeWindow,
      bias: bias.data,
    } satisfies SheetCritical,
  };
};

// ─────────────────────────────────────────────────────────────────────
// Pure sheet assembly — exported for unit tests.
// ─────────────────────────────────────────────────────────────────────

export type EdgeDirection = "yes" | "no" | "neutral";
export type RowConfidence = "low" | "medium" | "high";

function edgeDirection(bias: number): EdgeDirection {
  if (bias > 0) return "yes";
  if (bias < 0) return "no";
  return "neutral";
}

function rowConfidence(conviction: number): RowConfidence {
  if (conviction >= CONVICTION_HIGH) return "high";
  if (conviction >= CONVICTION_MEDIUM) return "medium";
  return "low";
}

/** Ranked spine: |bias| desc, conviction desc as tie-break. */
export function rankMarkets(markets: BiasMarket[]): BiasMarket[] {
  return markets
    .filter((m) => typeof m.market_id === "string" && m.market_id.length > 0)
    .slice()
    .sort((a, b) => {
      const d = Math.abs(b.bias_score ?? 0) - Math.abs(a.bias_score ?? 0);
      if (d !== 0) return d;
      return (b.conviction_score ?? 0) - (a.conviction_score ?? 0);
    });
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Raw-layer guard: no object bigger than RAW_CAP_BYTES gets through. */
function capRaw(v: unknown): unknown {
  try {
    const s = JSON.stringify(v);
    if (typeof s !== "string") return null;
    if (s.length <= RAW_CAP_BYTES) return v;
    return { truncated: true, bytes: s.length };
  } catch {
    return null;
  }
}

interface WhaleAgg {
  count: number;
  net_usd: number;
  dominant_side: "YES" | "NO" | "EVEN";
  entrant_hashes: string[];
}

/** Roll the whale tape up per market: YES buys minus NO buys, USD. */
function aggregateWhaleEntries(entries: WhaleEntry[]): Map<string, WhaleAgg> {
  const byMarket = new Map<string, WhaleAgg>();
  for (const e of entries) {
    if (typeof e.market_id !== "string" || e.market_id.length === 0) continue;
    const size = typeof e.size_usd === "number" && Number.isFinite(e.size_usd) ? e.size_usd : 0;
    const agg = byMarket.get(e.market_id) ?? {
      count: 0,
      net_usd: 0,
      dominant_side: "EVEN" as const,
      entrant_hashes: [],
    };
    agg.count += 1;
    agg.net_usd += e.side === "NO" ? -size : size;
    if (
      typeof e.trader_address_hash === "string" &&
      !agg.entrant_hashes.includes(e.trader_address_hash)
    ) {
      agg.entrant_hashes.push(e.trader_address_hash);
    }
    byMarket.set(e.market_id, agg);
  }
  for (const agg of byMarket.values()) {
    agg.net_usd = round2(agg.net_usd);
    agg.dominant_side = agg.net_usd > 0 ? "YES" : agg.net_usd < 0 ? "NO" : "EVEN";
  }
  return byMarket;
}

export interface HoldersJoin {
  /** Position-holders rows keyed by market_id (top-5 markets only). */
  byMarket: Record<string, HoldersItem>;
  /** Upstream calls attempted (<= POSITION_HOLDERS_MAX_CALLS). */
  attempted: number;
  /** Of those, how many failed. */
  failed: number;
}

export interface BuildSheetArgs {
  critical: SheetCritical;
  whale: SourceResult<WhaleResponse>;
  skill: SourceResult<SkillResponse>;
  holders: HoldersJoin;
  limit: number;
  computedAt: Date;
}

/**
 * Pure four-layer assembly: verdict / sheet / signals / data_quality
 * (+ a size-capped raw layer). All join logic lives here so it can be
 * unit-tested without any fetch plumbing.
 */
export function buildSmartSheetResponse(args: BuildSheetArgs): Record<string, unknown> {
  const { critical, whale, skill, holders, limit, computedAt } = args;
  const meta = critical.bias.meta;
  const biasComputedAt =
    typeof meta["calculated_at"] === "string" ? meta["calculated_at"] : null;

  const staleSources: string[] = [];
  if (!whale.ok) staleSources.push("whale_entries");
  if (!skill.ok) staleSources.push("trader_skill");
  if (holders.failed > 0) staleSources.push("position_holders");

  const ranked = rankMarkets(critical.bias.data);
  const topHolderIds = new Set(
    ranked.slice(0, POSITION_HOLDERS_TOP_N).map((m) => m.market_id),
  );
  // whale-entries only supports 1h|6h|24h upstream; the fetcher maps
  // every wider sheet window to 24h. Label rows with the EFFECTIVE
  // window so a 1h sheet never mislabels 1h whale data as 24h.
  const whaleWindow = critical.timeWindow === "1h" ? "1h" : "24h";

  const whaleAgg = whale.ok
    ? aggregateWhaleEntries(whale.data.data)
    : new Map<string, WhaleAgg>();
  const skillByHash = new Map<string, SkillTrader>();
  if (skill.ok) {
    for (const t of skill.data.data) {
      if (typeof t.trader_address_hash === "string") {
        skillByHash.set(t.trader_address_hash, t);
      }
    }
  }

  const sheet = ranked.slice(0, limit).map((m, i) => {
    const bias = m.bias_score ?? 0;
    const conviction = m.conviction_score ?? 0;
    const agg = whale.ok ? (whaleAgg.get(m.market_id) ?? null) : null;

    // Skill positioning is joined THROUGH the whale entrants' hashes —
    // trader-skill is trader-level, whale entries are the market link.
    let skillPositioning: Record<string, unknown> | null = null;
    if (skill.ok && agg !== null) {
      const matched = agg.entrant_hashes
        .map((h) => skillByHash.get(h))
        .filter((t): t is SkillTrader => t !== undefined);
      const scores = matched
        .map((t) => t.overall_skill_score)
        .filter((s): s is number => typeof s === "number");
      const best = matched.reduce<SkillTrader | null>(
        (acc, t) =>
          acc === null ||
          (t.overall_skill_score ?? 0) > (acc.overall_skill_score ?? 0)
            ? t
            : acc,
        null,
      );
      skillPositioning = {
        ranked_entrants: matched.length,
        avg_entrant_skill:
          scores.length > 0
            ? round2(scores.reduce((a, b) => a + b, 0) / scores.length)
            : null,
        best_entrant_rank: best?.rank ?? null,
        best_entrant_tier: best?.tier ?? null,
      };
    }

    const holderRow = topHolderIds.has(m.market_id)
      ? (holders.byMarket[m.market_id] ?? null)
      : null;
    const holderConcentration =
      holderRow === null
        ? null
        : {
            skilled_holders_yes: holderRow.skilled_holders_count_yes ?? null,
            skilled_holders_no: holderRow.skilled_holders_count_no ?? null,
            yes_concentration: holderRow.yes_position_concentration ?? null,
            side_dominant: holderRow.side_dominant ?? null,
            total_value_usd: holderRow.total_value_usd_combined ?? null,
            largest_position_usd: holderRow.largest_position_usd ?? null,
            holders_conviction_score: holderRow.conviction_score ?? null,
          };

    return {
      rank: i + 1,
      market_id: m.market_id,
      title: m.market_title ?? null,
      category: m.category ?? null,
      bias_score: bias,
      direction: edgeDirection(bias),
      confidence: rowConfidence(conviction),
      conviction_score: conviction,
      whale_entries:
        agg === null
          ? null
          : {
              window: whaleWindow,
              count: agg.count,
              net_usd: agg.net_usd,
              dominant_side: agg.dominant_side,
            },
      skill_positioning: skillPositioning,
      holder_concentration: holderConcentration,
      freshness: { bias_computed_at: biasComputedAt },
    };
  });

  // ── verdict ────────────────────────────────────────────────────────
  const marketsWithEdge = ranked.filter((m) => (m.bias_score ?? 0) !== 0).length;
  // A zero-bias top row means NO market has an edge — top_pick must be
  // null so the verdict never contradicts markets_with_edge: 0.
  const top = ranked[0] ?? null;
  const topPick =
    top === null || (top.bias_score ?? 0) === 0
      ? null
      : {
          market_id: top.market_id,
          title: top.market_title ?? null,
          direction: edgeDirection(top.bias_score ?? 0),
          bias_score: top.bias_score ?? 0,
          confidence: rowConfidence(top.conviction_score ?? 0),
        };
  // Confidence: coverage_level "beta" is the calibrated ceiling; any
  // non-beta coverage or degraded source knocks it down a notch.
  const degraded =
    staleSources.length + (meta["coverage_level"] === "beta" ? 0 : 1);
  const confidence: RowConfidence =
    degraded === 0 ? "high" : degraded === 1 ? "medium" : "low";
  const first =
    topPick === null
      ? `No active Polymarket market currently shows a smart-money edge over the last ${critical.timeWindow}.`
      : `Smart money shows an edge in ${marketsWithEdge} active Polymarket market${marketsWithEdge === 1 ? "" : "s"} over the last ${critical.timeWindow}; ` +
        `strongest: "${topPick.title ?? topPick.market_id}" leaning ${topPick.direction.toUpperCase()} (bias ${topPick.bias_score}).`;
  const second =
    staleSources.length > 0
      ? ` Note: ${staleSources.join(", ")} unavailable for this read, so confidence is reduced.`
      : "";

  // ── signals ────────────────────────────────────────────────────────
  let whaleTotals: Record<string, unknown> | null = null;
  if (whale.ok) {
    let yesUsd = 0;
    let noUsd = 0;
    for (const e of whale.data.data) {
      const size = typeof e.size_usd === "number" && Number.isFinite(e.size_usd) ? e.size_usd : 0;
      if (e.side === "NO") noUsd += size;
      else yesUsd += size;
    }
    whaleTotals = {
      window: whaleWindow,
      entries: whale.data.data.length,
      yes_usd: round2(yesUsd),
      no_usd: round2(noUsd),
      net_usd: round2(yesUsd - noUsd),
    };
  }
  let matchedEntrants = 0;
  if (skill.ok && whale.ok) {
    const seen = new Set<string>();
    for (const agg of whaleAgg.values()) {
      for (const h of agg.entrant_hashes) {
        if (skillByHash.has(h)) seen.add(h);
      }
    }
    matchedEntrants = seen.size;
  }
  const sourcesUsed = ["smart_bias"];
  if (whale.ok) sourcesUsed.push("whale_entries");
  if (skill.ok) sourcesUsed.push("trader_skill");
  if (holders.attempted > holders.failed) sourcesUsed.push("position_holders");

  return {
    verdict: {
      markets_with_edge: marketsWithEdge,
      top_pick: topPick,
      summary: `${first}${second}`,
      confidence,
    },
    sheet,
    signals: {
      sources_used: sourcesUsed,
      whale_totals: whaleTotals,
      skill_coverage: skill.ok
        ? {
            ranked_traders: skill.data.data.length,
            entrants_matched: matchedEntrants,
          }
        : null,
    },
    data_quality: {
      stale_sources: staleSources,
      computed_at: computedAt.toISOString(),
      sheet_rows: sheet.length,
      sources: {
        smart_bias: "fresh",
        whale_entries: whale.ok ? "fresh" : "unavailable",
        trader_skill: skill.ok ? "fresh" : "unavailable",
        position_holders:
          holders.attempted === 0
            ? "skipped"
            : holders.failed === 0
              ? "fresh"
              : holders.attempted > holders.failed
                ? "degraded"
                : "unavailable",
      },
    },
    raw: {
      smart_bias_meta: capRaw(meta),
      whale_meta: whale.ok ? capRaw(whale.data.meta) : null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// The handler
// ─────────────────────────────────────────────────────────────────────

export const polymarketSmartSheet: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  const rejected = polymarketSmartSheetValidator(input.body, input.method);
  if (rejected) return rejected;
  const parsed = parseSheetBody(input.body);
  if (parsed.kind !== "ok") {
    // Unreachable after the validator, kept for type narrowing.
    return {
      status: 422,
      body: { error: parsed.error, input_schema: polymarketSmartSheetInputSchema },
    };
  }
  const opts = parsed.opts;

  // Critical source: reuse the preflight's bias fetch when it matches
  // this request's filters; recompute only as a fallback (direct
  // invocation / tests). Failing here means the buyer HAS paid, so
  // this is a last-resort 503, not the primary gate.
  let critical: SheetCritical;
  if (
    isSheetCritical(input.preflightData) &&
    input.preflightData.category === opts.category &&
    input.preflightData.timeWindow === opts.timeWindow
  ) {
    critical = input.preflightData;
  } else {
    const bias = await fetchSmartBias(input, opts.category, opts.timeWindow);
    if (!bias.ok) {
      return {
        status: 503,
        body: {
          error: "critical_source_unavailable",
          source: "smart_bias",
          detail: bias.error,
          retryable: true,
        },
      };
    }
    critical = {
      kind: "polymarket_smart_sheet_critical",
      category: opts.category,
      timeWindow: opts.timeWindow,
      bias: bias.data,
    };
  }

  // Enrichment fan-out — failures degrade, never fail the call.
  const [whale, skill] = await Promise.all([
    fetchWhaleEntries(input, opts.category, opts.timeWindow),
    fetchTraderSkill(input, opts.category),
  ]);

  // Position-holders: ONLY the top-5 markets by |bias|, sequential,
  // hard-capped at 5 upstream calls. The route has no market_id
  // filter, so calls are scoped per category (cached — duplicate
  // categories in the top 5 cost nothing extra) and joined locally.
  const ranked = rankMarkets(critical.bias.data);
  const holderByMarket: Record<string, HoldersItem> = {};
  const holdersCache = new Map<string, HoldersItem[] | null>();
  let phAttempted = 0;
  let phFailed = 0;
  for (const m of ranked.slice(0, POSITION_HOLDERS_TOP_N)) {
    const cat: SheetCategory =
      typeof m.category === "string" &&
      (CATEGORIES as readonly string[]).includes(m.category) &&
      m.category !== "all"
        ? (m.category as SheetCategory)
        : "all";
    if (!holdersCache.has(cat)) {
      if (phAttempted >= POSITION_HOLDERS_MAX_CALLS) break;
      phAttempted += 1;
      const res = await fetchPositionHolders(input, cat);
      if (!res.ok) phFailed += 1;
      holdersCache.set(cat, res.ok ? res.data : null);
    }
    const items = holdersCache.get(cat);
    if (items) {
      const hit = items.find((h) => h.market_id === m.market_id);
      if (hit) holderByMarket[m.market_id] = hit;
    }
  }

  return {
    status: 200,
    body: buildSmartSheetResponse({
      critical,
      whale,
      skill,
      holders: { byMarket: holderByMarket, attempted: phAttempted, failed: phFailed },
      limit: opts.limit,
      computedAt: new Date(),
    }),
  };
};
