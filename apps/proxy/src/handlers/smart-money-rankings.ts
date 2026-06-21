/**
 * Smart-money RANKING endpoints — four list/leaderboard verdicts built
 * entirely from our own smart-money-tracker tables (no external dep):
 *
 *   smart-money-token-rankings  — tokens ranked by smart_money_score
 *   smart-money-accumulation    — tokens with positive smart net inflow
 *   smart-money-distribution    — tokens with negative smart net inflow
 *   smart-money-top-wallets     — the eligible-wallet PnL leaderboard
 *
 * Sources (internal, the moat):
 *   - sm_netflow_cache       — precomputed per-token buy/sell/net flow,
 *                              smart_money_score, momentum_rank, per
 *                              time_window. ONLY the 30d window is kept
 *                              fresh by the tracker, so these endpoints
 *                              read the 30d window and report computed_at
 *                              + a `stale` flag rather than ever silently
 *                              serving a frozen window.
 *   - sm_token_metadata_cache — symbol/name decoration (LEFT JOIN).
 *   - sm_wallets              — the scoring table for top-wallets, gated
 *                              by the same hybrid eligibility filter the
 *                              smart-money API and wallet-reputation use.
 *
 * Fail-closed: every endpoint registers a preflight that runs the actual
 * query BEFORE settlement; if the source table is unreachable the buyer
 * gets a 503 and is NOT charged. The proven rows thread into the handler
 * as preflightData so nothing is queried twice.
 *
 * Input is all-optional ({ chain?, limit? }); an empty body is a valid
 * call (defaults applied) AND still reaches the 402 challenge so catalog
 * crawlers read the input_schema.
 */
import type {
  DbQuerier,
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerPreflight,
  InternalHandlerResult,
  InternalHandlerValidator,
} from "./types.js";
import type { InternalHandlerInputSchema } from "./discovery.js";

// ─────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────

const SUPPORTED_CHAINS = ["base", "solana"] as const;
type Chain = (typeof SUPPORTED_CHAINS)[number];
const DEFAULT_CHAIN: Chain = "solana";
const NETFLOW_WINDOW = "30d"; // the only window the tracker keeps fresh
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Hybrid eligibility gate — identical to wallet-reputation / the
// smart-money API (score >= 60, confidence >= 50, not quarantined).
const ELIGIBLE_MIN_SCORE = 60;
const ELIGIBLE_MIN_CONFIDENCE = 50;
const EXCLUDED_WALLET_STATUSES = ["quarantined", "blacklisted"];

// Data older than this is reported with stale=true (the 30d cache is
// normally recomputed well within a day; a frozen worker must show).
const STALE_AFTER_HOURS = 48;

// ─────────────────────────────────────────────────────────────────────
// Input parsing — shared by all four endpoints
// ─────────────────────────────────────────────────────────────────────

export type RankingInput =
  | { kind: "discovery" }
  | { kind: "invalid_json" }
  | { kind: "malformed" }
  | { kind: "invalid_chain"; value: string }
  | { kind: "invalid_limit"; value: unknown }
  | { kind: "ok"; chain: Chain; limit: number };

export function parseRankingInput(body: Buffer | null): RankingInput {
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
  const obj = parsed as Record<string, unknown>;
  let chain: Chain = DEFAULT_CHAIN;
  if (obj["chain"] !== undefined && obj["chain"] !== null && obj["chain"] !== "") {
    const c = String(obj["chain"]).toLowerCase();
    if (!SUPPORTED_CHAINS.includes(c as Chain)) {
      return { kind: "invalid_chain", value: String(obj["chain"]) };
    }
    chain = c as Chain;
  }
  let limit = DEFAULT_LIMIT;
  if (obj["limit"] !== undefined && obj["limit"] !== null && obj["limit"] !== "") {
    const n = Number(obj["limit"]);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      return { kind: "invalid_limit", value: obj["limit"] };
    }
    limit = n;
  }
  return { kind: "ok", chain, limit };
}

/** Shared validator: only PRESENT-but-bad values 422; empty → 402. */
function makeRankingValidator(): InternalHandlerValidator {
  return (body) => {
    const p = parseRankingInput(body);
    switch (p.kind) {
      case "discovery":
      case "ok":
        return null;
      case "invalid_json":
        return { status: 400, body: { error: "invalid_json_body" } };
      case "malformed":
        return {
          status: 422,
          body: {
            error: "body_must_be_object",
            expected: '{"chain":"base|solana","limit":20}',
          },
        };
      case "invalid_chain":
        return {
          status: 422,
          body: {
            error: "invalid_chain",
            detail: `chain must be one of ${SUPPORTED_CHAINS.join(", ")}`,
            received: p.value,
          },
        };
      case "invalid_limit":
        return {
          status: 422,
          body: {
            error: "invalid_limit",
            detail: `limit must be an integer 1..${MAX_LIMIT}`,
            received: p.value,
          },
        };
    }
  };
}

function inputSchema(extra: string): InternalHandlerInputSchema {
  return {
    method: "POST",
    content_type: "application/json",
    body: {
      type: "object",
      required: [],
      properties: {
        chain: {
          type: "string",
          description: `Chain to rank (${SUPPORTED_CHAINS.join(" | ")}). ${extra} Default ${DEFAULT_CHAIN}.`,
          pattern: `^(${SUPPORTED_CHAINS.join("|")})$`,
        },
        limit: {
          type: "integer",
          description: `Rows to return, 1..${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.`,
        },
      },
    },
    example: { chain: DEFAULT_CHAIN, limit: DEFAULT_LIMIT },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────

function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round2(x: number | null): number | null {
  return x === null ? null : Math.round(x * 100) / 100;
}

interface DataQuality {
  computed_at: string | null;
  stale: boolean;
  row_count: number;
}
function dataQuality(latest: Date | null, count: number, now: Date): DataQuality {
  const stale =
    latest === null ||
    (now.getTime() - latest.getTime()) / 3_600_000 > STALE_AFTER_HOURS;
  return {
    computed_at: latest ? latest.toISOString() : null,
    stale,
    row_count: count,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Netflow-cache backed endpoints (token-rankings / accumulation / distribution)
// ─────────────────────────────────────────────────────────────────────

type NetflowMode = "rankings" | "accumulation" | "distribution";

const NETFLOW_BASE_SELECT = `
  SELECT n.token_address, n.buy_usd::float8 AS buy_usd,
         n.sell_usd::float8 AS sell_usd,
         n.net_flow_usd::float8 AS net_flow_usd,
         n.gross_flow_usd::float8 AS gross_flow_usd,
         n.avg_trade_size_usd::float8 AS avg_trade_size_usd,
         n.unique_traders, n.new_active_wallets_count,
         n.smart_money_score::float8 AS smart_money_score,
         n.momentum_rank, n.computed_at,
         m.symbol, m.name
    FROM sm_netflow_cache n
    LEFT JOIN sm_token_metadata_cache m
      ON m.token_address = n.token_address AND m.chain = n.chain
   WHERE n.chain = $1 AND n.time_window = $2`;

function netflowSql(mode: NetflowMode): string {
  if (mode === "accumulation") {
    return `${NETFLOW_BASE_SELECT} AND n.net_flow_usd > 0
            ORDER BY n.net_flow_usd DESC NULLS LAST LIMIT $3`;
  }
  if (mode === "distribution") {
    return `${NETFLOW_BASE_SELECT} AND n.net_flow_usd < 0
            ORDER BY n.net_flow_usd ASC NULLS LAST LIMIT $3`;
  }
  return `${NETFLOW_BASE_SELECT}
          ORDER BY n.smart_money_score DESC NULLS LAST,
                   n.net_flow_usd DESC NULLS LAST LIMIT $3`;
}

export interface NetflowRow {
  token: string | null;
  symbol: string | null;
  name: string | null;
  buy_usd: number | null;
  sell_usd: number | null;
  net_flow_usd: number | null;
  gross_flow_usd: number | null;
  avg_trade_size_usd: number | null;
  unique_traders: number | null;
  new_active_wallets: number | null;
  smart_money_score: number | null;
  momentum_rank: number | null;
}

export function shapeNetflowRow(r: Record<string, unknown>): NetflowRow {
  return {
    token: (r["token_address"] as string | null) ?? null,
    symbol: (r["symbol"] as string | null) ?? null,
    name: (r["name"] as string | null) ?? null,
    buy_usd: round2(num(r["buy_usd"])),
    sell_usd: round2(num(r["sell_usd"])),
    net_flow_usd: round2(num(r["net_flow_usd"])),
    gross_flow_usd: round2(num(r["gross_flow_usd"])),
    avg_trade_size_usd: round2(num(r["avg_trade_size_usd"])),
    unique_traders: num(r["unique_traders"]),
    new_active_wallets: num(r["new_active_wallets_count"]),
    smart_money_score: round2(num(r["smart_money_score"])),
    momentum_rank: num(r["momentum_rank"]),
  };
}

interface NetflowCritical {
  kind: "sm_netflow_critical";
  mode: NetflowMode;
  chain: Chain;
  limit: number;
  rows: Array<Record<string, unknown>>;
  latest: Date | null;
}

async function queryNetflow(
  db: DbQuerier,
  mode: NetflowMode,
  chain: Chain,
  limit: number,
): Promise<NetflowCritical> {
  const { rows } = await db.query(netflowSql(mode), [chain, NETFLOW_WINDOW, limit]);
  let latest: Date | null = null;
  for (const r of rows) {
    const d = asDate(r["computed_at"]);
    if (d && (latest === null || d > latest)) latest = d;
  }
  return { kind: "sm_netflow_critical", mode, chain, limit, rows, latest };
}

function isNetflowCritical(v: unknown): v is NetflowCritical {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as NetflowCritical).kind === "sm_netflow_critical"
  );
}

const NETFLOW_TITLE: Record<NetflowMode, string> = {
  rankings: "tokens ranked by smart-money score",
  accumulation: "tokens being accumulated by smart money (net inflow)",
  distribution: "tokens being distributed by smart money (net outflow)",
};

function buildNetflowResponse(c: NetflowCritical, now: Date): Record<string, unknown> {
  return {
    kind: c.mode,
    chain: c.chain,
    time_window: NETFLOW_WINDOW,
    description: NETFLOW_TITLE[c.mode],
    count: c.rows.length,
    tokens: c.rows.map(shapeNetflowRow),
    data_quality: dataQuality(c.latest, c.rows.length, now),
  };
}

function makeNetflowPreflight(mode: NetflowMode): InternalHandlerPreflight {
  return async (input) => {
    if (!input.db) {
      return {
        proceed: false,
        status: 503,
        body: { error: "critical_source_unavailable", source: "sm_netflow_cache", retryable: true },
      };
    }
    const p = parseRankingInput(input.body);
    const chain = p.kind === "ok" ? p.chain : DEFAULT_CHAIN;
    const limit = p.kind === "ok" ? p.limit : DEFAULT_LIMIT;
    try {
      const critical = await queryNetflow(input.db, mode, chain, limit);
      return { proceed: true, data: critical };
    } catch (err) {
      return {
        proceed: false,
        status: 503,
        body: {
          error: "critical_source_unavailable",
          source: "sm_netflow_cache",
          detail: (err as Error).message ?? "unknown",
          retryable: true,
        },
      };
    }
  };
}

function makeNetflowHandler(mode: NetflowMode): InternalHandler {
  const validator = makeRankingValidator();
  return async (input: InternalHandlerInput): Promise<InternalHandlerResult> => {
    const rejected = validator(input.body, input.method);
    if (rejected) return rejected;
    const now = new Date();
    let critical: NetflowCritical;
    if (isNetflowCritical(input.preflightData) && input.preflightData.mode === mode) {
      critical = input.preflightData;
    } else {
      if (!input.db) {
        return {
          status: 503,
          body: { error: "critical_source_unavailable", source: "sm_netflow_cache", retryable: true },
        };
      }
      const p = parseRankingInput(input.body);
      const chain = p.kind === "ok" ? p.chain : DEFAULT_CHAIN;
      const limit = p.kind === "ok" ? p.limit : DEFAULT_LIMIT;
      try {
        critical = await queryNetflow(input.db, mode, chain, limit);
      } catch (err) {
        return {
          status: 503,
          body: {
            error: "critical_source_unavailable",
            source: "sm_netflow_cache",
            detail: (err as Error).message ?? "unknown",
            retryable: true,
          },
        };
      }
    }
    return { status: 200, body: buildNetflowResponse(critical, now) };
  };
}

// ─────────────────────────────────────────────────────────────────────
// sm_wallets backed endpoint (top-wallets leaderboard)
// ─────────────────────────────────────────────────────────────────────

const TOP_WALLETS_SQL = `
  SELECT address, tier,
         score::float8 AS score, confidence_score,
         win_rate::float8 AS win_rate,
         pnl_90d_usd::float8 AS pnl_90d_usd,
         realized_pnl_usd::float8 AS realized_pnl_usd,
         profit_factor::float8 AS profit_factor,
         trade_count_90d, distinct_tokens_30d,
         median_holding_time_seconds, last_scored_at, last_activity_at
    FROM sm_wallets
   WHERE chain = $1
     AND score >= ${ELIGIBLE_MIN_SCORE}
     AND confidence_score >= ${ELIGIBLE_MIN_CONFIDENCE}
     AND status <> ALL($3::text[])
   ORDER BY score DESC NULLS LAST, pnl_90d_usd DESC NULLS LAST
   LIMIT $2`;

export interface TopWalletRow {
  address: string;
  tier: string | null;
  score: number | null;
  confidence_score: number | null;
  win_rate: number | null;
  pnl_90d_usd: number | null;
  realized_pnl_usd: number | null;
  profit_factor: number | null;
  trade_count_90d: number | null;
  distinct_tokens_30d: number | null;
  median_holding_time_seconds: number | null;
  last_scored_at: string | null;
  last_activity_at: string | null;
}

export function shapeTopWallet(r: Record<string, unknown>): TopWalletRow {
  return {
    address: String(r["address"]),
    tier: (r["tier"] as string | null) ?? null,
    score: round2(num(r["score"])),
    confidence_score: num(r["confidence_score"]),
    win_rate: round2(num(r["win_rate"])),
    pnl_90d_usd: round2(num(r["pnl_90d_usd"])),
    realized_pnl_usd: round2(num(r["realized_pnl_usd"])),
    profit_factor: round2(num(r["profit_factor"])),
    trade_count_90d: num(r["trade_count_90d"]),
    distinct_tokens_30d: num(r["distinct_tokens_30d"]),
    median_holding_time_seconds: num(r["median_holding_time_seconds"]),
    last_scored_at: asDate(r["last_scored_at"])?.toISOString() ?? null,
    last_activity_at: asDate(r["last_activity_at"])?.toISOString() ?? null,
  };
}

interface TopWalletsCritical {
  kind: "sm_top_wallets_critical";
  chain: Chain;
  limit: number;
  rows: Array<Record<string, unknown>>;
  latest: Date | null;
}

async function queryTopWallets(
  db: DbQuerier,
  chain: Chain,
  limit: number,
): Promise<TopWalletsCritical> {
  const { rows } = await db.query(TOP_WALLETS_SQL, [chain, limit, EXCLUDED_WALLET_STATUSES]);
  let latest: Date | null = null;
  for (const r of rows) {
    const d = asDate(r["last_scored_at"]);
    if (d && (latest === null || d > latest)) latest = d;
  }
  return { kind: "sm_top_wallets_critical", chain, limit, rows, latest };
}

function isTopWalletsCritical(v: unknown): v is TopWalletsCritical {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as TopWalletsCritical).kind === "sm_top_wallets_critical"
  );
}

function buildTopWalletsResponse(c: TopWalletsCritical, now: Date): Record<string, unknown> {
  return {
    kind: "top_wallets",
    chain: c.chain,
    description:
      "eligible smart-money wallets ranked by skill score then 90d PnL (hybrid eligibility gate: score>=60, confidence>=50)",
    count: c.rows.length,
    wallets: c.rows.map(shapeTopWallet),
    data_quality: dataQuality(c.latest, c.rows.length, now),
  };
}

export const smartMoneyTopWalletsPreflight: InternalHandlerPreflight = async (input) => {
  if (!input.db) {
    return {
      proceed: false,
      status: 503,
      body: { error: "critical_source_unavailable", source: "sm_wallets", retryable: true },
    };
  }
  const p = parseRankingInput(input.body);
  const chain = p.kind === "ok" ? p.chain : DEFAULT_CHAIN;
  const limit = p.kind === "ok" ? p.limit : DEFAULT_LIMIT;
  try {
    const critical = await queryTopWallets(input.db, chain, limit);
    return { proceed: true, data: critical };
  } catch (err) {
    return {
      proceed: false,
      status: 503,
      body: {
        error: "critical_source_unavailable",
        source: "sm_wallets",
        detail: (err as Error).message ?? "unknown",
        retryable: true,
      },
    };
  }
};

export const smartMoneyTopWallets: InternalHandler = async (input) => {
  const validator = makeRankingValidator();
  const rejected = validator(input.body, input.method);
  if (rejected) return rejected;
  const now = new Date();
  let critical: TopWalletsCritical;
  if (isTopWalletsCritical(input.preflightData)) {
    critical = input.preflightData;
  } else {
    if (!input.db) {
      return {
        status: 503,
        body: { error: "critical_source_unavailable", source: "sm_wallets", retryable: true },
      };
    }
    const p = parseRankingInput(input.body);
    const chain = p.kind === "ok" ? p.chain : DEFAULT_CHAIN;
    const limit = p.kind === "ok" ? p.limit : DEFAULT_LIMIT;
    try {
      critical = await queryTopWallets(input.db, chain, limit);
    } catch (err) {
      return {
        status: 503,
        body: {
          error: "critical_source_unavailable",
          source: "sm_wallets",
          detail: (err as Error).message ?? "unknown",
          retryable: true,
        },
      };
    }
  }
  return { status: 200, body: buildTopWalletsResponse(critical, now) };
};

// ─────────────────────────────────────────────────────────────────────
// Public exports — handlers, validators, preflights, input schemas
// ─────────────────────────────────────────────────────────────────────

export const smartMoneyTokenRankings = makeNetflowHandler("rankings");
export const smartMoneyAccumulation = makeNetflowHandler("accumulation");
export const smartMoneyDistribution = makeNetflowHandler("distribution");

export const smartMoneyTokenRankingsPreflight = makeNetflowPreflight("rankings");
export const smartMoneyAccumulationPreflight = makeNetflowPreflight("accumulation");
export const smartMoneyDistributionPreflight = makeNetflowPreflight("distribution");

export const smartMoneyRankingValidator = makeRankingValidator();

export const smartMoneyTokenRankingsInputSchema = inputSchema(
  "Ranks tracked tokens by aggregate smart-money score over the trailing 30 days.",
);
export const smartMoneyAccumulationInputSchema = inputSchema(
  "Lists tokens with the largest positive smart-money net inflow over 30 days.",
);
export const smartMoneyDistributionInputSchema = inputSchema(
  "Lists tokens with the largest negative smart-money net flow (distribution) over 30 days.",
);
export const smartMoneyTopWalletsInputSchema = inputSchema(
  "Ranks eligible smart-money wallets by skill score then 90d PnL.",
);
