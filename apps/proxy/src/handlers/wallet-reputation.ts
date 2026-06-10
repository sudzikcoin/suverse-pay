/**
 * Wallet Reputation — ONE aggregated $0.03 verdict answering "can this
 * Solana wallet's trading be trusted / is it worth copying?". Buyer
 * POSTs { wallet } and gets:
 *
 *   verdict      — tier + activity + 2-3 sentence summary + confidence
 *   signals      — scoring row axes, sm_trades aggregates, style flags,
 *                  up to 10 recent trades
 *   data_quality — stale sources + tracked/untracked coverage
 *   raw          — scoring row, trade aggregates, helius sample
 *
 * Sources (all internal except the optional enrichment):
 *   1. sm_wallets    — the smart-money-tracker scoring table (~11k
 *                      wallets, score 0-100, hybrid eligibility gate).
 *   2. sm_trades     — the wallet's indexed trade history.
 *   3. Helius Enhanced Transactions — OPTIONAL recent-activity
 *      decoration. Failure degrades (stale_sources + lower
 *      confidence), never fails the call.
 *
 * Fail-closed: the verdict is impossible without sm_wallets +
 * sm_trades, so `walletReputationPreflight` proves both BEFORE the
 * payment settles. The preflight also STARTS the Helius fetch
 * (non-blocking) so its latency is absorbed by settlement time; the
 * handler awaits it after payment.
 *
 * PRIVACY GUARD: this endpoint reports ONLY the queried address's
 * on-chain trading activity as indexed in our own tables plus parsed
 * on-chain transactions from Helius. It performs no off-chain identity
 * enrichment of any kind and must never gain any.
 */
import type {
  DbQuerier,
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerPreflight,
  InternalHandlerResult,
  InternalHandlerValidator,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────

const CHAIN = "solana";

// Wallet eligibility — same hybrid gate the smart-money API applies
// (workers/scoring eligibility.ts, mirrored in crypto-market-pulse):
// score >= 60, confidence >= 50, quarantined/blacklisted never surface.
const ELIGIBLE_MIN_SCORE = 60;
const ELIGIBLE_MIN_CONFIDENCE = 50;
const EXCLUDED_WALLET_STATUSES = ["quarantined", "blacklisted"];

// Tier boundaries (spec): skilled >= 70, average 40..69, weak < 40.
const SKILLED_MIN_SCORE = 70;
const AVERAGE_MIN_SCORE = 40;

// Activity windows.
const ACTIVE_MAX_DAYS = 7;
const DORMANT_MIN_DAYS = 30;

// Style-flag thresholds.
const HIGH_FREQUENCY_MIN_TRADES_7D = 20;
const LARGE_SIZE_MIN_AVG_USD = 1000;
const DIVERSIFIED_MIN_TOKENS_30D = 10;
const CONCENTRATED_MAX_TOKENS_30D = 2;
const CONCENTRATED_MIN_TRADES_30D = 5;

// "high" confidence requires a score computed within the last 7 days.
const FRESH_SCORE_MAX_DAYS = 7;

const RECENT_TRADES_LIMIT = 10;
const HELIUS_TX_LIMIT = 10;
const HELIUS_RAW_SAMPLE = 3;
const HELIUS_TIMEOUT_MS = 4_000;

// Stable / quote mints excluded from the distinct-token count and used
// for buy/sell side attribution — copied from smart-money-tracker
// netflow-query.ts (same set crypto-market-pulse uses for solana).
const STABLE_MINTS = [
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "So11111111111111111111111111111111111111112",
];

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ─────────────────────────────────────────────────────────────────────
// Verdict logic — pure, exported for unit tests.
// ─────────────────────────────────────────────────────────────────────

export type Tier = "elite" | "skilled" | "average" | "weak" | "unknown";
export type Activity = "active" | "dormant" | "occasional";
export type StyleFlag =
  | "high_frequency"
  | "large_size"
  | "diversified"
  | "concentrated";
export type Confidence = "low" | "medium" | "high";

export interface ScoringRow {
  address: string;
  status: string;
  score: number | null;
  confidence_score: number | null;
  score_version: string | null;
  last_scored_at: Date | null;
  [k: string]: unknown;
}

/** The tracker's hybrid eligibility gate, evaluated on a scoring row. */
export function isEligible(row: ScoringRow): boolean {
  return (
    row.score !== null &&
    row.score >= ELIGIBLE_MIN_SCORE &&
    row.confidence_score !== null &&
    row.confidence_score >= ELIGIBLE_MIN_CONFIDENCE &&
    !EXCLUDED_WALLET_STATUSES.includes(row.status)
  );
}

/**
 * Tier ladder. Eligibility beats raw score (an eligible 62 is elite;
 * a quarantined 95 is merely skilled). A tracked-but-never-scored row
 * is "unknown" — being discovered is not a signal.
 */
export function deriveTier(row: ScoringRow | null): Tier {
  if (row === null) return "unknown";
  if (isEligible(row)) return "elite";
  if (row.score === null) return "unknown";
  if (row.score >= SKILLED_MIN_SCORE) return "skilled";
  if (row.score >= AVERAGE_MIN_SCORE) return "average";
  return "weak";
}

/**
 * active     — traded within the last 7 days
 * dormant    — no trades for 30+ days (or no trades at all)
 * occasional — in between
 */
export function deriveActivity(lastTradeAt: Date | null, now: Date): Activity {
  if (lastTradeAt === null) return "dormant";
  const days = (now.getTime() - lastTradeAt.getTime()) / 86_400_000;
  if (days <= ACTIVE_MAX_DAYS) return "active";
  if (days >= DORMANT_MIN_DAYS) return "dormant";
  return "occasional";
}

export interface TradeAggregates {
  trade_count_24h: number;
  trade_count_7d: number;
  trade_count_30d: number;
  trade_count_total: number;
  volume_usd_30d: number;
  distinct_tokens_30d: number;
  avg_trade_size_usd: number | null;
  first_seen: Date | null;
  last_trade_at: Date | null;
}

/** Flags are only emitted when the data positively supports them. */
export function deriveStyleFlags(agg: TradeAggregates): StyleFlag[] {
  const flags: StyleFlag[] = [];
  if (agg.trade_count_7d >= HIGH_FREQUENCY_MIN_TRADES_7D) {
    flags.push("high_frequency");
  }
  if (
    agg.trade_count_30d > 0 &&
    agg.avg_trade_size_usd !== null &&
    agg.avg_trade_size_usd >= LARGE_SIZE_MIN_AVG_USD
  ) {
    flags.push("large_size");
  }
  if (agg.distinct_tokens_30d >= DIVERSIFIED_MIN_TOKENS_30D) {
    flags.push("diversified");
  }
  if (
    agg.distinct_tokens_30d >= 1 &&
    agg.distinct_tokens_30d <= CONCENTRATED_MAX_TOKENS_30D &&
    agg.trade_count_30d >= CONCENTRATED_MIN_TRADES_30D
  ) {
    flags.push("concentrated");
  }
  return flags;
}

/**
 * high   — tracked AND scored within the last 7 days
 * medium — tracked but the score is older (or never computed)
 * low    — untracked
 * A failed Helius enrichment degrades the result one level.
 */
export function deriveWalletConfidence(
  row: ScoringRow | null,
  now: Date,
  heliusOk: boolean,
): Confidence {
  let base: Confidence;
  if (row === null) {
    base = "low";
  } else if (
    row.last_scored_at !== null &&
    (now.getTime() - row.last_scored_at.getTime()) / 86_400_000 <=
      FRESH_SCORE_MAX_DAYS
  ) {
    base = "high";
  } else {
    base = "medium";
  }
  if (!heliusOk) {
    if (base === "high") return "medium";
    return "low";
  }
  return base;
}

const TIER_PHRASE: Record<Tier, string> = {
  elite:
    "currently passes our smart-money eligibility filter, placing it in the elite tier of tracked wallets",
  skilled:
    "shows high skill but does not currently pass the full eligibility filter, so copy with caution",
  average:
    "rates as average among tracked wallets, with no strong edge signal in its history",
  weak: "rates as weak; its tracked history argues against copying it",
  unknown:
    "is not scored in our smart-money tracking universe, so we have no skill signal for it",
};

export interface SummaryInput {
  tier: Tier;
  score: number | null;
  activity: Activity;
  agg: TradeAggregates;
  flags: StyleFlag[];
  staleSources: string[];
}

/** 2-3 plain-English sentences a non-quant agent can act on. */
export function buildWalletSummary(v: SummaryInput): string {
  const first =
    `This wallet ` +
    (v.score !== null ? `scores ${v.score}/100 and ` : "") +
    `${TIER_PHRASE[v.tier]}.`;
  const second =
    v.agg.trade_count_total === 0
      ? "We have no recorded trades for it in our index."
      : `It is ${v.activity}, with ${v.agg.trade_count_30d} trade${v.agg.trade_count_30d === 1 ? "" : "s"} in the last 30 days` +
        ` (about $${v.agg.volume_usd_30d.toFixed(2)} across ${v.agg.distinct_tokens_30d} distinct token${v.agg.distinct_tokens_30d === 1 ? "" : "s"})` +
        (v.agg.last_trade_at !== null
          ? `, last trade ${v.agg.last_trade_at.toISOString().slice(0, 10)}.`
          : ".");
  const thirdParts: string[] = [];
  if (v.flags.length > 0) {
    thirdParts.push(`Trading style: ${v.flags.join(", ")}.`);
  }
  if (v.staleSources.length > 0) {
    thirdParts.push(
      `Note: ${v.staleSources.join(", ")} unavailable for this read, so confidence is reduced.`,
    );
  }
  return [first, second, ...thirdParts].join(" ");
}

// ─────────────────────────────────────────────────────────────────────
// DB queries
// ─────────────────────────────────────────────────────────────────────

const SCORING_SQL = `
  SELECT address, chain, status, tier, score::float8 AS score,
         confidence_score, score_version, last_scored_at,
         last_activity_at, discovered_at,
         win_rate::float8 AS win_rate,
         pnl_90d_usd::float8 AS pnl_90d_usd,
         profit_factor::float8 AS profit_factor,
         trade_count_90d, distinct_tokens_30d AS scored_distinct_tokens_30d
    FROM sm_wallets
   WHERE chain = $1 AND address = $2
`;

const AGGREGATES_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE timestamp >= $3)::int AS trade_count_24h,
    COUNT(*) FILTER (WHERE timestamp >= $4)::int AS trade_count_7d,
    COUNT(*) FILTER (WHERE timestamp >= $5)::int AS trade_count_30d,
    COUNT(*)::int AS trade_count_total,
    COALESCE(SUM(value_usd) FILTER (WHERE timestamp >= $5), 0)::float8
      AS volume_usd_30d,
    AVG(value_usd) FILTER (WHERE timestamp >= $5)::float8
      AS avg_trade_size_usd,
    MIN(timestamp) AS first_seen,
    MAX(timestamp) AS last_trade_at
  FROM sm_trades
  WHERE chain = $1 AND wallet_address = $2
`;

// Distinct VOLATILE tokens touched in the last 30d — stables/SOL are
// plumbing, not positions, so they don't count toward diversification.
const DISTINCT_TOKENS_SQL = `
  SELECT COUNT(*)::int AS distinct_tokens_30d FROM (
    SELECT token_in AS tok FROM sm_trades
     WHERE chain = $1 AND wallet_address = $2 AND timestamp >= $3
       AND token_in IS NOT NULL AND NOT (token_in = ANY($4::text[]))
    UNION
    SELECT token_out FROM sm_trades
     WHERE chain = $1 AND wallet_address = $2 AND timestamp >= $3
       AND token_out IS NOT NULL AND NOT (token_out = ANY($4::text[]))
  ) toks
`;

const RECENT_TRADES_SQL = `
  SELECT t.timestamp, t.tx_type, t.token_in, t.token_out,
         t.value_usd::float8 AS value_usd,
         mi.symbol AS symbol_in, mo.symbol AS symbol_out
    FROM sm_trades t
    LEFT JOIN sm_token_metadata_cache mi
      ON mi.token_address = t.token_in AND mi.chain = t.chain
    LEFT JOIN sm_token_metadata_cache mo
      ON mo.token_address = t.token_out AND mo.chain = t.chain
   WHERE t.chain = $1 AND t.wallet_address = $2
   ORDER BY t.timestamp DESC
   LIMIT $3
`;

interface RecentTradeRow {
  timestamp: Date;
  tx_type: string;
  token_in: string | null;
  token_out: string | null;
  value_usd: number | null;
  symbol_in: string | null;
  symbol_out: string | null;
}

export interface RecentTrade {
  token: string | null;
  side: string;
  usd: number | null;
  timestamp: string;
}

/**
 * Buy = stable in, volatile out. Sell = volatile in, stable out.
 * Anything else (vol-to-vol swap, transfer, lp event) keeps its
 * tx_type as the side. The reported token is the volatile leg.
 */
export function classifyTrade(row: RecentTradeRow): RecentTrade {
  const inStable = row.token_in !== null && STABLE_MINTS.includes(row.token_in);
  const outStable =
    row.token_out !== null && STABLE_MINTS.includes(row.token_out);
  let side = row.tx_type;
  let token: string | null = null;
  if (row.tx_type === "swap" && row.token_out !== null && !outStable && inStable) {
    side = "buy";
    token = row.symbol_out ?? row.token_out;
  } else if (
    row.tx_type === "swap" &&
    row.token_in !== null &&
    !inStable &&
    outStable
  ) {
    side = "sell";
    token = row.symbol_in ?? row.token_in;
  } else if (row.token_out !== null && !outStable) {
    token = row.symbol_out ?? row.token_out;
  } else if (row.token_in !== null && !inStable) {
    token = row.symbol_in ?? row.token_in;
  }
  return {
    token,
    side,
    usd: row.value_usd !== null ? round2(row.value_usd) : null,
    timestamp: new Date(row.timestamp).toISOString(),
  };
}

function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

async function queryScoringRow(
  db: DbQuerier,
  wallet: string,
): Promise<ScoringRow | null> {
  const { rows } = await db.query(SCORING_SQL, [CHAIN, wallet]);
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    ...r,
    address: String(r["address"]),
    status: String(r["status"]),
    score: r["score"] === null ? null : Number(r["score"]),
    confidence_score:
      r["confidence_score"] === null ? null : Number(r["confidence_score"]),
    score_version:
      r["score_version"] === null ? null : String(r["score_version"]),
    last_scored_at: asDate(r["last_scored_at"]),
  };
}

async function queryAggregates(
  db: DbQuerier,
  wallet: string,
  now: Date,
): Promise<TradeAggregates> {
  const d24 = new Date(now.getTime() - 24 * 3_600_000);
  const d7 = new Date(now.getTime() - 7 * 86_400_000);
  const d30 = new Date(now.getTime() - 30 * 86_400_000);
  const [aggRes, tokRes] = await Promise.all([
    db.query(AGGREGATES_SQL, [CHAIN, wallet, d24, d7, d30]),
    db.query(DISTINCT_TOKENS_SQL, [CHAIN, wallet, d30, STABLE_MINTS]),
  ]);
  const a = aggRes.rows[0] ?? {};
  return {
    trade_count_24h: Number(a["trade_count_24h"] ?? 0),
    trade_count_7d: Number(a["trade_count_7d"] ?? 0),
    trade_count_30d: Number(a["trade_count_30d"] ?? 0),
    trade_count_total: Number(a["trade_count_total"] ?? 0),
    volume_usd_30d: round2(Number(a["volume_usd_30d"] ?? 0)),
    distinct_tokens_30d: Number(tokRes.rows[0]?.["distinct_tokens_30d"] ?? 0),
    avg_trade_size_usd:
      a["avg_trade_size_usd"] === null || a["avg_trade_size_usd"] === undefined
        ? null
        : round2(Number(a["avg_trade_size_usd"])),
    first_seen: asDate(a["first_seen"]),
    last_trade_at: asDate(a["last_trade_at"]),
  };
}

async function queryRecentTrades(
  db: DbQuerier,
  wallet: string,
): Promise<RecentTrade[]> {
  const { rows } = await db.query(RECENT_TRADES_SQL, [
    CHAIN,
    wallet,
    RECENT_TRADES_LIMIT,
  ]);
  return rows.map((r) =>
    classifyTrade({
      timestamp: asDate(r["timestamp"]) ?? new Date(0),
      tx_type: String(r["tx_type"]),
      token_in: (r["token_in"] as string | null) ?? null,
      token_out: (r["token_out"] as string | null) ?? null,
      value_usd: r["value_usd"] === null ? null : Number(r["value_usd"]),
      symbol_in: (r["symbol_in"] as string | null) ?? null,
      symbol_out: (r["symbol_out"] as string | null) ?? null,
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helius enrichment — OPTIONAL, degrades on any failure.
// ─────────────────────────────────────────────────────────────────────

type HeliusResult =
  | { ok: true; transactions: unknown[] }
  | { ok: false; error: string };

async function fetchHeliusActivity(
  wallet: string,
  fetchImpl: typeof fetch,
): Promise<HeliusResult> {
  const apiKey = process.env["HELIUS_API_KEY"];
  if (!apiKey) return { ok: false, error: "helius_not_configured" };
  const url =
    `https://api.helius.xyz/v0/addresses/${encodeURIComponent(wallet)}` +
    `/transactions?api-key=${encodeURIComponent(apiKey)}&limit=${HELIUS_TX_LIMIT}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HELIUS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `helius_status_${res.status}` };
    const data: unknown = await res.json();
    if (!Array.isArray(data)) return { ok: false, error: "helius_bad_shape" };
    return { ok: true, transactions: data };
  } catch {
    return { ok: false, error: "helius_unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Critical data + preflight (fail-closed gate)
// ─────────────────────────────────────────────────────────────────────

interface CriticalData {
  kind: "wallet_reputation_critical";
  wallet: string;
  scoring: ScoringRow | null;
  aggregates: TradeAggregates;
  recentTrades: RecentTrade[];
  /**
   * Enrichment fetch STARTED during preflight so its latency overlaps
   * on-chain settlement; never rejects (failures resolve to ok:false).
   */
  helius: Promise<HeliusResult>;
}

function isCriticalData(v: unknown): v is CriticalData {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as CriticalData).kind === "wallet_reputation_critical"
  );
}

function parseWallet(body: Buffer | null): string | null {
  if (!body || body.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const wallet = (parsed as Record<string, unknown>)["wallet"];
    if (typeof wallet !== "string" || !BASE58_RE.test(wallet)) return null;
    return wallet;
  } catch {
    return null;
  }
}

async function computeCriticalData(
  input: InternalHandlerInput,
  wallet: string,
): Promise<
  | { ok: true; data: CriticalData }
  | { ok: false; source: string; error: string }
> {
  if (!input.db) {
    return { ok: false, source: "smart_money_db", error: "no_db_wired" };
  }
  const db = input.db;
  const now = new Date();
  let scoring: ScoringRow | null;
  let aggregates: TradeAggregates;
  let recentTrades: RecentTrade[];
  try {
    scoring = await queryScoringRow(db, wallet);
  } catch (err) {
    return {
      ok: false,
      source: "sm_wallets",
      error: `scoring_query_failed: ${(err as Error).message ?? "unknown"}`,
    };
  }
  try {
    [aggregates, recentTrades] = await Promise.all([
      queryAggregates(db, wallet, now),
      queryRecentTrades(db, wallet),
    ]);
  } catch (err) {
    return {
      ok: false,
      source: "sm_trades",
      error: `trades_query_failed: ${(err as Error).message ?? "unknown"}`,
    };
  }
  // Kick off enrichment WITHOUT awaiting — the dispatcher settles the
  // payment next, which takes far longer than Helius does to answer.
  const helius = fetchHeliusActivity(wallet, input.fetchImpl ?? fetch).catch(
    () => ({ ok: false as const, error: "helius_unreachable" }),
  );
  return {
    ok: true,
    data: {
      kind: "wallet_reputation_critical",
      wallet,
      scoring,
      aggregates,
      recentTrades,
      helius,
    },
  };
}

/**
 * Pre-payment validator. Invalid JSON → 400; a missing or non-base58
 * `wallet` → 422. Either way the buyer never sees the 402 challenge
 * and never pays for a call that was always going to fail.
 */
export const walletReputationValidator: InternalHandlerValidator = (
  body,
  _method,
) => {
  if (!body || body.length === 0) {
    return {
      status: 422,
      body: { error: "wallet_required", expected: '{"wallet":"<solana base58 address>"}' },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { status: 400, body: { error: "invalid_json_body" } };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      status: 422,
      body: { error: "wallet_required", expected: '{"wallet":"<solana base58 address>"}' },
    };
  }
  const wallet = (parsed as Record<string, unknown>)["wallet"];
  if (typeof wallet !== "string" || wallet.length === 0) {
    return { status: 422, body: { error: "wallet_required" } };
  }
  if (!BASE58_RE.test(wallet)) {
    return {
      status: 422,
      body: {
        error: "invalid_wallet_address",
        detail: "wallet must be a base58 Solana address (32-44 chars)",
      },
    };
  }
  return null;
};

/**
 * Fail-closed gate, run by the dispatcher BEFORE the payment settles.
 * Proves sm_wallets + sm_trades are reachable by running the actual
 * queries; on success the result threads into the handler as
 * `preflightData` so nothing is queried twice. On failure the buyer
 * gets a 503 and is NOT charged.
 */
export const walletReputationPreflight: InternalHandlerPreflight = async (
  input,
) => {
  const wallet = parseWallet(input.body);
  if (wallet === null) {
    // The validator runs first in the dispatcher, so this is only a
    // belt-and-braces guard for direct invocation.
    return {
      status: 422,
      proceed: false,
      body: { error: "invalid_wallet_address" },
    };
  }
  const critical = await computeCriticalData(input, wallet);
  if (!critical.ok) {
    return {
      proceed: false,
      status: 503,
      body: {
        error: "critical_source_unavailable",
        source: critical.source,
        detail: critical.error,
        retryable: true,
      },
    };
  }
  return { proceed: true, data: critical.data };
};

// ─────────────────────────────────────────────────────────────────────
// The handler
// ─────────────────────────────────────────────────────────────────────

export const walletReputation: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  const rejected = walletReputationValidator(input.body, input.method);
  if (rejected) return rejected;
  const wallet = parseWallet(input.body);
  if (wallet === null) {
    return { status: 422, body: { error: "invalid_wallet_address" } };
  }

  // Critical data: normally pre-computed by the preflight on this same
  // request. The recompute path covers direct invocation (tests, dev)
  // — if it fails here the buyer HAS paid, so this is a last-resort
  // 503, not the primary gate.
  let critical: CriticalData;
  if (isCriticalData(input.preflightData)) {
    critical = input.preflightData;
  } else {
    const computed = await computeCriticalData(input, wallet);
    if (!computed.ok) {
      return {
        status: 503,
        body: {
          error: "critical_source_unavailable",
          source: computed.source,
          detail: computed.error,
          retryable: true,
        },
      };
    }
    critical = computed.data;
  }

  const helius = await critical.helius;

  return {
    status: 200,
    body: buildReputationResponse({
      wallet: critical.wallet,
      scoring: critical.scoring,
      aggregates: critical.aggregates,
      recentTrades: critical.recentTrades,
      helius,
      computedAt: new Date(),
    }),
  };
};

export interface BuildReputationArgs {
  wallet: string;
  scoring: ScoringRow | null;
  aggregates: TradeAggregates;
  recentTrades: RecentTrade[];
  helius: HeliusResult;
  computedAt: Date;
}

/** Pure assembly of the three-layer response — exported for tests. */
export function buildReputationResponse(
  args: BuildReputationArgs,
): Record<string, unknown> {
  const { wallet, scoring, aggregates, recentTrades, helius, computedAt } =
    args;

  const tier = deriveTier(scoring);
  const activity = deriveActivity(aggregates.last_trade_at, computedAt);
  const flags = deriveStyleFlags(aggregates);
  const staleSources: string[] = [];
  if (!helius.ok) staleSources.push("helius_enhanced_transactions");
  const confidence = deriveWalletConfidence(scoring, computedAt, helius.ok);
  const score = scoring?.score ?? null;
  const summary = buildWalletSummary({
    tier,
    score,
    activity,
    agg: aggregates,
    flags,
    staleSources,
  });

  return {
    wallet,
    verdict: { tier, score, activity, summary, confidence },
    signals: {
      scoring: scoring
        ? {
            score,
            eligible: isEligible(scoring),
            score_version: scoring.score_version,
            last_scored_at: scoring.last_scored_at?.toISOString() ?? null,
          }
        : null,
      trading: {
        trade_count_24h: aggregates.trade_count_24h,
        trade_count_7d: aggregates.trade_count_7d,
        trade_count_30d: aggregates.trade_count_30d,
        volume_usd_30d: aggregates.volume_usd_30d,
        distinct_tokens_30d: aggregates.distinct_tokens_30d,
        avg_trade_size_usd: aggregates.avg_trade_size_usd,
        first_seen: aggregates.first_seen?.toISOString() ?? null,
        last_trade_at: aggregates.last_trade_at?.toISOString() ?? null,
      },
      style: flags,
      recent_activity: recentTrades,
    },
    data_quality: {
      stale_sources: staleSources,
      computed_at: computedAt.toISOString(),
      tracking_coverage: scoring !== null ? "tracked" : "untracked",
    },
    raw: {
      scoring_row: scoring,
      trade_aggregates: aggregates,
      helius_sample: helius.ok
        ? helius.transactions.slice(0, HELIUS_RAW_SAMPLE)
        : null,
    },
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
