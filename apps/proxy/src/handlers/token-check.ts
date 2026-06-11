/**
 * Token Check — ONE aggregated $0.05 verdict answering "what's the
 * state of this Solana token — is it sane to enter?". Buyer POSTs
 * { token } and gets:
 *
 *   verdict      — risk_level + flags + 2-3 sentence summary + confidence
 *   signals      — liquidity / concentration / age / authority /
 *                  momentum / elite_flow axes
 *   data_quality — stale sources + concentration source + computed_at
 *   raw          — per-source payloads (long arrays capped at 20)
 *
 * All thresholds come from the token-check research report
 * (2026-06-11) — real measurements, not guesses. Sources:
 *
 *   1. ELITE FLOW (ours, sm_trades x sm_wallets)   — CRITICAL (DB)
 *   2. Jupiter tokens/v2 search                     — CRITICAL
 *   3. Jupiter swap quote, $500 notional            — CRITICAL
 *      ("no route" is a first-class RESULT — liquidity=untradeable —
 *       not an error; only infra failure fails the call)
 *   4. Helius RPC holder concentration (3 calls)    — degrades to
 *      jupiter_audit on BONK-class "account index service overloaded"
 *   5. Helius getAsset metadata cross-check         — optional
 *   6. DexScreener pairs enrichment                 — optional
 *
 * Fail-closed: `tokenCheckPreflight` proves 1-3 BEFORE the payment
 * settles. The slow holder chain (research long pole, p50 589ms) is
 * STARTED during preflight and awaited in the handler, so its latency
 * overlaps on-chain settlement (wallet-reputation Helius pattern).
 *
 * ELITE FRESHNESS GUARD (research §1c): the elite cohort genuinely
 * goes quiet for days (zero eligible-wallet trades Jun 7-10 while the
 * overall feed stayed alive). When the WHOLE cohort's latest trade is
 * older than 48h, a token-level empty result is reported as
 * "no_signal_cohort_silent" — never phrased as elite avoiding this
 * token. The elite axis NEVER moves risk_level (research: only 3% of
 * tokens have >=3 elite wallets) — it is its own premium layer.
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
// Tunables — empirically derived in the token-check research report.
// ─────────────────────────────────────────────────────────────────────

const CHAIN = "solana";

// Wallet eligibility — same hybrid gate the smart-money API applies
// (workers/scoring eligibility.ts, mirrored in crypto-market-pulse and
// wallet-reputation): score >= 60, confidence >= 50,
// quarantined/blacklisted never surface.
const ELIGIBLE_MIN_SCORE = 60;
const ELIGIBLE_MIN_CONFIDENCE = 50;
const EXCLUDED_WALLET_STATUSES = ["quarantined", "blacklisted"];

// Stable / quote mints — same set as crypto-market-pulse (solana).
const STABLE_MINTS = [
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "So11111111111111111111111111111111111111112",
];
const USDC_MINT = STABLE_MINTS[0]!;

const ELITE_WINDOW_DAYS = 30;
/** Cohort-level staleness gate (research §1c: feed silent Jun 7-10). */
const ELITE_FEED_MAX_LAG_HOURS = 48;

// Liquidity probe: one $500 USDC quote; priceImpactPct is the signal.
const QUOTE_NOTIONAL_ATOMIC = 500_000_000; // $500 in 6-dp USDC
const QUOTE_SLIPPAGE_BPS = 300;

// Liquidity buckets (research §4: BONK 0.044%, thin tokens 17.6-26.6%).
const LIQ_DEEP_MAX_PCT = 0.5;
const LIQ_ADEQUATE_MAX_PCT = 3;
const LIQ_THIN_MAX_PCT = 10;

// Concentration buckets on wallet-held top-10 share AFTER pool
// exclusion (research §2a: bonding-curve tokens measured 5.8% and
// 16.4% wallet-held where the naive numbers read 99.2% and 85.0%).
const CONC_DISTRIBUTED_MAX_PCT = 20;
const CONC_ELEVATED_MAX_PCT = 40;

// Age buckets from firstPool.createdAt.
const AGE_VERY_NEW_MAX_HOURS = 48;
const AGE_NEW_MAX_DAYS = 14;
const AGE_YOUNG_MAX_DAYS = 90;

// Momentum label cutoffs on stats24h.priceChange (percent). Simple by
// design: |change| >= 25 is volatile, >= +5 rising, <= -5 falling,
// otherwise flat.
const MOMENTUM_VOLATILE_MIN_ABS_PCT = 25;
const MOMENTUM_RISING_MIN_PCT = 5;
const MOMENTUM_FALLING_MAX_PCT = -5;

const TOP_HOLDER_ACCOUNTS = 10;
/** Owner accounts owned by the System Program are regular wallets. */
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

// lite-api.jup.ag and dexscreener both 403 the default undici UA
// (research §3) — any browser-like UA passes.
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) SuVersePay/1.0";

const CRITICAL_TIMEOUT_MS = 8_000;
const HOLDERS_TIMEOUT_MS = 6_000;
const OPTIONAL_TIMEOUT_MS = 4_000;

const RAW_ARRAY_CAP = 20;

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ─────────────────────────────────────────────────────────────────────
// Pure verdict logic — exported for unit tests.
// ─────────────────────────────────────────────────────────────────────

export type LiquidityBucket =
  | "deep"
  | "adequate"
  | "thin"
  | "exit_trap"
  | "untradeable";
export type ConcentrationBucket = "distributed" | "elevated" | "concentrated";
export type AgeBucket = "very_new" | "new" | "young" | "established";
export type MomentumLabel = "rising" | "falling" | "flat" | "volatile";
export type RiskLevel = "low" | "moderate" | "high" | "critical";
export type Confidence = "low" | "medium" | "high";
export type EliteStatus =
  | "active"
  | "no_elite_interest"
  | "no_signal_cohort_silent";
export type TokenCheckFlag =
  | "unknown_token"
  | "untradeable"
  | "mint_authority_live"
  | "freeze_authority_live"
  | "dev_mints"
  | "metadata_mismatch";

/** priceImpactPct is a FRACTION upstream (0.1755 = 17.55%); callers
 *  pass percent. null = quote answered "no route" → untradeable. */
export function bucketLiquidity(impactPct: number | null): LiquidityBucket {
  if (impactPct === null) return "untradeable";
  if (impactPct < LIQ_DEEP_MAX_PCT) return "deep";
  if (impactPct <= LIQ_ADEQUATE_MAX_PCT) return "adequate";
  if (impactPct <= LIQ_THIN_MAX_PCT) return "thin";
  return "exit_trap";
}

export function bucketConcentration(
  walletHeldTop10Pct: number,
): ConcentrationBucket {
  if (walletHeldTop10Pct < CONC_DISTRIBUTED_MAX_PCT) return "distributed";
  if (walletHeldTop10Pct <= CONC_ELEVATED_MAX_PCT) return "elevated";
  return "concentrated";
}

export function bucketAge(firstPoolAt: Date, now: Date): AgeBucket {
  const hours = (now.getTime() - firstPoolAt.getTime()) / 3_600_000;
  if (hours < AGE_VERY_NEW_MAX_HOURS) return "very_new";
  if (hours < AGE_NEW_MAX_DAYS * 24) return "new";
  if (hours < AGE_YOUNG_MAX_DAYS * 24) return "young";
  return "established";
}

export interface JupAudit {
  mintAuthorityDisabled?: boolean | null;
  freezeAuthorityDisabled?: boolean | null;
  devMints?: number | null;
  topHoldersPercentage?: number | null;
  [k: string]: unknown;
}

/** Flags only fire on positive evidence; an absent audit emits none. */
export function deriveAuthorityFlags(audit: JupAudit | null): TokenCheckFlag[] {
  if (!audit) return [];
  const flags: TokenCheckFlag[] = [];
  if (audit.mintAuthorityDisabled === false) flags.push("mint_authority_live");
  if (audit.freezeAuthorityDisabled === false) {
    flags.push("freeze_authority_live");
  }
  if (typeof audit.devMints === "number" && audit.devMints > 0) {
    flags.push("dev_mints");
  }
  return flags;
}

export function deriveMomentumLabel(
  priceChange24hPct: number | null,
): MomentumLabel | null {
  if (priceChange24hPct === null) return null;
  if (Math.abs(priceChange24hPct) >= MOMENTUM_VOLATILE_MIN_ABS_PCT) {
    return "volatile";
  }
  if (priceChange24hPct >= MOMENTUM_RISING_MIN_PCT) return "rising";
  if (priceChange24hPct <= MOMENTUM_FALLING_MAX_PCT) return "falling";
  return "flat";
}

export interface EliteCard {
  buy_usd: number;
  sell_usd: number;
  net_usd: number;
  distinct_elite_wallets: number;
  /**
   * Wallets collapsed by sm_wallets.cluster_id (coordinated-timing
   * detection): members of one cluster count as ONE logical actor.
   * Equals distinct_elite_wallets when no member is clustered.
   */
  distinct_elite_clusters: number;
  trade_legs: number;
  first_elite_trade: string | null;
  last_elite_trade: string | null;
  hours_since_last_elite_trade: number | null;
}

/**
 * Research §1c guard: token-level data present → full card regardless
 * of cohort state (the trades happened). Token-level EMPTY splits on
 * cohort freshness — a silent cohort must never read as the elite
 * avoiding this specific token.
 */
export function deriveEliteStatus(
  legs: number,
  eliteFeedLagHours: number | null,
): EliteStatus {
  if (legs > 0) return "active";
  if (
    eliteFeedLagHours === null ||
    eliteFeedLagHours > ELITE_FEED_MAX_LAG_HOURS
  ) {
    return "no_signal_cohort_silent";
  }
  return "no_elite_interest";
}

export interface RiskInput {
  liquidity: LiquidityBucket | null;
  concentration: ConcentrationBucket | null;
  age: AgeBucket | null;
  flags: TokenCheckFlag[];
}

/**
 * The risk matrix (spec'd from research thresholds). The elite axis is
 * deliberately absent — it never moves risk_level.
 */
export function deriveRiskLevel(input: RiskInput): RiskLevel {
  const { liquidity, concentration, age, flags } = input;
  const authorityFlags = flags.filter(
    (f) =>
      f === "mint_authority_live" ||
      f === "freeze_authority_live" ||
      f === "dev_mints",
  );
  if (
    liquidity === "untradeable" ||
    (liquidity === "exit_trap" && age === "very_new") ||
    flags.includes("mint_authority_live") ||
    flags.includes("unknown_token")
  ) {
    return "critical";
  }
  if (
    liquidity === "exit_trap" ||
    concentration === "concentrated" ||
    (liquidity === "thin" && age === "very_new")
  ) {
    return "high";
  }
  if (
    liquidity === "thin" ||
    concentration === "elevated" ||
    ((age === "new" || age === "very_new") && authorityFlags.length > 0)
  ) {
    return "moderate";
  }
  return "low";
}

/**
 * high   — all critical sources fresh AND concentration came from the
 *          RPC chain (not the jupiter_audit fallback).
 * medium — exactly one degradation.
 * low    — two or more.
 */
export function deriveTokenCheckConfidence(degradations: number): Confidence {
  if (degradations === 0) return "high";
  if (degradations === 1) return "medium";
  return "low";
}

const LIQ_PHRASE: Record<LiquidityBucket, string> = {
  deep: "liquidity is deep",
  adequate: "liquidity is adequate",
  thin: "liquidity is thin",
  exit_trap:
    "liquidity is an exit trap (a $500 sale would move the price double digits)",
  untradeable: "it currently has NO tradeable route at all",
};

const RISK_PHRASE: Record<RiskLevel, string> = {
  low: "Overall risk is low",
  moderate: "Overall risk is moderate",
  high: "Overall risk is high",
  critical: "Overall risk is CRITICAL",
};

export interface SummaryInput {
  symbol: string | null;
  riskLevel: RiskLevel;
  liquidity: LiquidityBucket | null;
  impactPct: number | null;
  concentration: ConcentrationBucket | null;
  walletHeldPct: number | null;
  age: AgeBucket | null;
  flags: TokenCheckFlag[];
  eliteStatus: EliteStatus;
  eliteCard: EliteCard | null;
  staleSources: string[];
}

/** 2-3 plain-English sentences; mentions the elite card when present. */
export function buildTokenSummary(v: SummaryInput): string {
  const name = v.symbol ? `${v.symbol}` : "This token";
  const axisBits: string[] = [];
  if (v.liquidity !== null) {
    axisBits.push(
      LIQ_PHRASE[v.liquidity] +
        (v.impactPct !== null && v.liquidity !== "untradeable"
          ? ` (${v.impactPct.toFixed(2)}% impact on a $500 buy)`
          : ""),
    );
  }
  if (v.concentration !== null) {
    axisBits.push(
      `top-10 wallet-held supply is ${v.concentration}` +
        (v.walletHeldPct !== null ? ` at ${v.walletHeldPct.toFixed(1)}%` : ""),
    );
  }
  if (v.age !== null) axisBits.push(`the token is ${v.age.replace("_", " ")}`);
  const first =
    `${RISK_PHRASE[v.riskLevel]} for ${name}` +
    (axisBits.length > 0 ? `: ${axisBits.join(", ")}.` : ".");

  let second: string;
  if (v.eliteStatus === "active" && v.eliteCard) {
    const card = v.eliteCard;
    const dir =
      card.net_usd > 0 ? "net buyers" : card.net_usd < 0 ? "net sellers" : "flat";
    const when =
      card.hours_since_last_elite_trade !== null
        ? `, last touch ${formatHours(card.hours_since_last_elite_trade)} ago`
        : "";
    // Cluster-collapsed honesty: when coordinated wallets fold into
    // fewer logical actors, the summary leads with the actor count.
    const who =
      card.distinct_elite_clusters < card.distinct_elite_wallets
        ? `${card.distinct_elite_clusters} independent actor${card.distinct_elite_clusters === 1 ? "" : "s"} ` +
          `(${card.distinct_elite_wallets} wallets, some operator-clustered)`
        : `${card.distinct_elite_wallets} wallet${card.distinct_elite_wallets === 1 ? "" : "s"}`;
    second =
      `Our elite smart-money cohort traded it: ${who}, ` +
      `$${card.buy_usd.toFixed(0)} bought vs $${card.sell_usd.toFixed(0)} sold ` +
      `(${dir})${when}.`;
  } else if (v.eliteStatus === "no_elite_interest") {
    second =
      "None of our elite smart-money wallets touched this token in the last 30 days.";
  } else {
    second =
      "Our elite smart-money feed is currently silent cohort-wide, so the absence of elite trades here carries no signal.";
  }

  const thirdParts: string[] = [];
  const dangerFlags = v.flags.filter((f) => f !== "metadata_mismatch");
  if (dangerFlags.length > 0) {
    thirdParts.push(`Flags: ${dangerFlags.join(", ")}.`);
  }
  if (v.flags.includes("metadata_mismatch")) {
    thirdParts.push(
      "On-chain metadata does not match the ecosystem listing (possible impersonation).",
    );
  }
  if (v.staleSources.length > 0) {
    thirdParts.push(
      `Note: ${v.staleSources.join(", ")} unavailable for this read, so confidence is reduced.`,
    );
  }
  return [first, second, ...thirdParts].join(" ");
}

function formatHours(h: number): string {
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

// ─────────────────────────────────────────────────────────────────────
// Holder classification — pure, exported for the pool-exclusion tests.
// ─────────────────────────────────────────────────────────────────────

export interface LargestAccount {
  address: string;
  amount: string;
}

export interface ClassifiedHolder {
  token_account: string;
  owner: string | null;
  kind: "wallet" | "pool";
  share_pct: number;
}

export interface HolderSplit {
  wallet_held_top10_pct: number;
  pool_held_top10_pct: number;
  holders: ClassifiedHolder[];
}

/**
 * The pool-exclusion math (research §2a): a top token account whose
 * OWNER is itself owned by the System Program is a regular wallet;
 * any program-owned owner (AMM authority, bonding-curve PDA,
 * Token-2022 vault, locker, multisig) counts as pool/PDA — either way
 * it is not free-floating wallet supply. Missing owner info classifies
 * as pool (conservative: never inflate the wallet-held number).
 */
export function classifyHolders(
  top: LargestAccount[],
  owners: Array<string | null>,
  ownerPrograms: Array<string | null>,
  supplyAtomic: number,
): HolderSplit {
  let walletPct = 0;
  let poolPct = 0;
  const holders: ClassifiedHolder[] = top.map((acc, i) => {
    const sharePct =
      supplyAtomic > 0 ? (100 * Number(acc.amount)) / supplyAtomic : 0;
    const owner = owners[i] ?? null;
    const program = ownerPrograms[i] ?? null;
    const kind: "wallet" | "pool" =
      owner !== null && program === SYSTEM_PROGRAM ? "wallet" : "pool";
    if (kind === "wallet") walletPct += sharePct;
    else poolPct += sharePct;
    return {
      token_account: acc.address,
      owner,
      kind,
      share_pct: round2(sharePct),
    };
  });
  return {
    wallet_held_top10_pct: round2(walletPct),
    pool_held_top10_pct: round2(poolPct),
    holders,
  };
}

// ─────────────────────────────────────────────────────────────────────
// DB queries — elite flow + cohort freshness
// ─────────────────────────────────────────────────────────────────────

const ELITE_CARD_SQL = `
  WITH eligible AS (
    SELECT address, cluster_id FROM sm_wallets
     WHERE chain = $1
       AND score >= $2
       AND confidence_score >= $3
       AND NOT (status = ANY($4::text[]))
  )
  SELECT
    COUNT(*)::int AS trade_legs,
    COUNT(DISTINCT t.wallet_address)::int AS distinct_elite_wallets,
    COUNT(DISTINCT COALESCE(e.cluster_id::text, t.wallet_address))::int
      AS distinct_elite_clusters,
    COALESCE(SUM(t.value_usd) FILTER (
      WHERE t.token_out = $5 AND t.token_in = ANY($6::text[])
    ), 0)::float8 AS buy_usd,
    COALESCE(SUM(t.value_usd) FILTER (
      WHERE t.token_in = $5 AND t.token_out = ANY($6::text[])
    ), 0)::float8 AS sell_usd,
    MIN(t.timestamp) AS first_elite_trade,
    MAX(t.timestamp) AS last_elite_trade
  FROM sm_trades t
  JOIN eligible e ON e.address = t.wallet_address
  WHERE t.chain = $1
    AND t.tx_type = 'swap'
    AND t.value_usd IS NOT NULL
    AND t.value_usd > 0
    AND (t.token_in = $5 OR t.token_out = $5)
    AND t.timestamp >= $7
`;

// Cohort-level freshness: latest trade by ANY eligible wallet, no
// token filter, no window — the research §1c guard input.
const ELITE_FEED_SQL = `
  WITH eligible AS (
    SELECT address FROM sm_wallets
     WHERE chain = $1
       AND score >= $2
       AND confidence_score >= $3
       AND NOT (status = ANY($4::text[]))
  )
  SELECT MAX(t.timestamp) AS last_elite_trade_at
  FROM sm_trades t
  JOIN eligible e ON e.address = t.wallet_address
  WHERE t.chain = $1
`;

export interface EliteFlowData {
  card: EliteCard;
  elite_feed_lag_hours: number | null;
  status: EliteStatus;
}

async function queryEliteFlow(
  db: DbQuerier,
  mint: string,
  now: Date,
): Promise<EliteFlowData> {
  const windowStart = new Date(
    now.getTime() - ELITE_WINDOW_DAYS * 86_400_000,
  );
  const params = [
    CHAIN,
    ELIGIBLE_MIN_SCORE,
    ELIGIBLE_MIN_CONFIDENCE,
    EXCLUDED_WALLET_STATUSES,
  ];
  const [cardRes, feedRes] = await Promise.all([
    db.query(ELITE_CARD_SQL, [...params, mint, STABLE_MINTS, windowStart]),
    db.query(ELITE_FEED_SQL, params),
  ]);
  const c = cardRes.rows[0] ?? {};
  const legs = Number(c["trade_legs"] ?? 0);
  const distinctWallets = Number(c["distinct_elite_wallets"] ?? 0);
  // Missing cluster info (pre-migration rows, stubs) = assume all
  // wallets independent — never inflate the honesty correction.
  const distinctClusters =
    c["distinct_elite_clusters"] === null ||
    c["distinct_elite_clusters"] === undefined
      ? distinctWallets
      : Number(c["distinct_elite_clusters"]);
  const buyUsd = round2(Number(c["buy_usd"] ?? 0));
  const sellUsd = round2(Number(c["sell_usd"] ?? 0));
  const lastTrade = asDate(c["last_elite_trade"]);
  const feedLast = asDate(feedRes.rows[0]?.["last_elite_trade_at"]);
  const eliteFeedLagHours =
    feedLast === null
      ? null
      : round2((now.getTime() - feedLast.getTime()) / 3_600_000);
  return {
    card: {
      buy_usd: buyUsd,
      sell_usd: sellUsd,
      net_usd: round2(buyUsd - sellUsd),
      distinct_elite_wallets: distinctWallets,
      distinct_elite_clusters: distinctClusters,
      trade_legs: legs,
      first_elite_trade: asDate(c["first_elite_trade"])?.toISOString() ?? null,
      last_elite_trade: lastTrade?.toISOString() ?? null,
      hours_since_last_elite_trade:
        lastTrade === null
          ? null
          : round2((now.getTime() - lastTrade.getTime()) / 3_600_000),
    },
    elite_feed_lag_hours: eliteFeedLagHours,
    status: deriveEliteStatus(legs, eliteFeedLagHours),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Source fetchers
// ─────────────────────────────────────────────────────────────────────

type SourceResult<T> =
  | { ok: true; data: T; raw: unknown }
  | { ok: false; error: string };

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface JupTokenInfo {
  id?: string;
  name?: string | null;
  symbol?: string | null;
  decimals?: number | null;
  holderCount?: number | null;
  organicScore?: number | null;
  organicScoreLabel?: string | null;
  audit?: JupAudit | null;
  firstPool?: { id?: string; createdAt?: string } | null;
  liquidity?: number | null;
  mcap?: number | null;
  usdPrice?: number | null;
  launchpad?: string | null;
  stats1h?: Record<string, unknown> | null;
  stats6h?: Record<string, unknown> | null;
  stats24h?: Record<string, unknown> | null;
  tags?: string[] | null;
  [k: string]: unknown;
}

/**
 * CRITICAL. `data: null` is a valid success — Jupiter has never seen
 * the mint (the unknown-token path). Only transport/HTTP failures
 * return ok:false.
 */
async function fetchJupToken(
  mint: string,
  fetchImpl: typeof fetch,
): Promise<SourceResult<JupTokenInfo | null>> {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`,
      CRITICAL_TIMEOUT_MS,
      {
        method: "GET",
        headers: { accept: "application/json", "user-agent": BROWSER_UA },
      },
    );
    if (!res.ok) return { ok: false, error: `jup_token_status_${res.status}` };
    const raw: unknown = await res.json();
    if (!Array.isArray(raw)) return { ok: false, error: "jup_token_bad_shape" };
    const exact =
      (raw as JupTokenInfo[]).find((t) => t.id === mint) ?? null;
    return { ok: true, data: exact, raw };
  } catch {
    return { ok: false, error: "jup_token_unreachable" };
  }
}

export interface QuoteData {
  /** Percent (upstream fraction * 100); null when no route exists. */
  price_impact_pct: number | null;
  no_route: boolean;
  error_code: string | null;
}

/**
 * CRITICAL, but "no route"/"not tradable" (HTTP 400 + errorCode) is a
 * first-class RESULT — the token is untradeable, which is exactly what
 * the buyer paid to learn. Only transport/5xx failures return ok:false.
 */
async function fetchJupQuote(
  mint: string,
  fetchImpl: typeof fetch,
): Promise<SourceResult<QuoteData>> {
  const url =
    `https://lite-api.jup.ag/swap/v1/quote?inputMint=${USDC_MINT}` +
    `&outputMint=${encodeURIComponent(mint)}` +
    `&amount=${QUOTE_NOTIONAL_ATOMIC}&slippageBps=${QUOTE_SLIPPAGE_BPS}`;
  try {
    const res = await fetchWithTimeout(fetchImpl, url, CRITICAL_TIMEOUT_MS, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": BROWSER_UA },
    });
    const raw: unknown = await res.json().catch(() => null);
    if (res.ok && raw !== null && typeof raw === "object") {
      const impactRaw = (raw as Record<string, unknown>)["priceImpactPct"];
      const fraction =
        typeof impactRaw === "string" || typeof impactRaw === "number"
          ? Number(impactRaw)
          : Number.NaN;
      if (!Number.isFinite(fraction)) {
        return { ok: false, error: "jup_quote_bad_shape" };
      }
      return {
        ok: true,
        data: {
          price_impact_pct: round4(fraction * 100),
          no_route: false,
          error_code: null,
        },
        raw,
      };
    }
    if (res.status === 400 && raw !== null && typeof raw === "object") {
      const code = (raw as Record<string, unknown>)["errorCode"];
      if (typeof code === "string") {
        // TOKEN_NOT_TRADABLE / COULD_NOT_FIND_ANY_ROUTE / ... —
        // deterministic token-level answers, not infra failures.
        return {
          ok: true,
          data: { price_impact_pct: null, no_route: true, error_code: code },
          raw,
        };
      }
    }
    return { ok: false, error: `jup_quote_status_${res.status}` };
  } catch {
    return { ok: false, error: "jup_quote_unreachable" };
  }
}

export type HoldersResult =
  | { ok: true; data: HolderSplit; raw: unknown }
  | { ok: false; degraded: true; error: string };

interface RpcEnvelope {
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * The 3-call holder chain (research §2): largest accounts → owners →
 * owning programs. Any failure degrades (never fails the call) — the
 * jupiter_audit fallback covers BONK-class tokens where the account
 * index itself refuses ("account index service overloaded", 429).
 */
async function fetchHolderConcentration(
  mint: string,
  fetchImpl: typeof fetch,
): Promise<HoldersResult> {
  const apiKey = process.env["HELIUS_API_KEY"];
  if (!apiKey) {
    return { ok: false, degraded: true, error: "helius_not_configured" };
  }
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
  const rpc = async (method: string, params: unknown[]): Promise<RpcEnvelope> => {
    const res = await fetchWithTimeout(fetchImpl, rpcUrl, HOLDERS_TIMEOUT_MS, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (res.status === 429) return { error: { code: 429, message: "rate_limited" } };
    return (await res.json()) as RpcEnvelope;
  };
  try {
    const [supplyRes, largestRes] = await Promise.all([
      rpc("getTokenSupply", [mint]),
      rpc("getTokenLargestAccounts", [mint]),
    ]);
    if (largestRes.error || supplyRes.error) {
      const msg =
        largestRes.error?.message ?? supplyRes.error?.message ?? "rpc_error";
      return { ok: false, degraded: true, error: `helius_rpc: ${msg}` };
    }
    const supplyAtomic = Number(
      (supplyRes.result as { value?: { amount?: string } })?.value?.amount,
    );
    const largest = (
      largestRes.result as { value?: LargestAccount[] }
    )?.value;
    if (!Array.isArray(largest) || !Number.isFinite(supplyAtomic)) {
      return { ok: false, degraded: true, error: "helius_bad_shape" };
    }
    const top = largest.slice(0, TOP_HOLDER_ACCOUNTS);
    if (top.length === 0) {
      return {
        ok: true,
        data: { wallet_held_top10_pct: 0, pool_held_top10_pct: 0, holders: [] },
        raw: { largest: [], supply_atomic: supplyAtomic },
      };
    }
    const ownersRes = await rpc("getMultipleAccounts", [
      top.map((a) => a.address),
      { encoding: "jsonParsed" },
    ]);
    if (ownersRes.error) {
      return {
        ok: false,
        degraded: true,
        error: `helius_rpc: ${ownersRes.error.message ?? "owners_failed"}`,
      };
    }
    const ownerOf = (acc: unknown): string | null => {
      const owner = (
        acc as { data?: { parsed?: { info?: { owner?: unknown } } } }
      )?.data?.parsed?.info?.owner;
      return typeof owner === "string" ? owner : null;
    };
    const accounts =
      (ownersRes.result as { value?: unknown[] })?.value ?? [];
    const owners = top.map((_, i) => ownerOf(accounts[i]));
    const distinctOwners = [
      ...new Set(owners.filter((o): o is string => o !== null)),
    ];
    const programsRes = await rpc("getMultipleAccounts", [
      distinctOwners,
      { encoding: "base64" },
    ]);
    if (programsRes.error) {
      return {
        ok: false,
        degraded: true,
        error: `helius_rpc: ${programsRes.error.message ?? "programs_failed"}`,
      };
    }
    const programByOwner = new Map<string, string | null>();
    const programAccounts =
      (programsRes.result as { value?: Array<{ owner?: string } | null> })
        ?.value ?? [];
    distinctOwners.forEach((owner, i) => {
      const acc = programAccounts[i];
      // A missing owner account (never funded) is a plain wallet
      // keypair address — System Program owned by definition.
      programByOwner.set(
        owner,
        acc === null || acc === undefined ? SYSTEM_PROGRAM : (acc.owner ?? null),
      );
    });
    const ownerPrograms = owners.map((o) =>
      o === null ? null : (programByOwner.get(o) ?? null),
    );
    const split = classifyHolders(top, owners, ownerPrograms, supplyAtomic);
    return {
      ok: true,
      data: split,
      raw: {
        supply_atomic: supplyAtomic,
        largest: top,
        owners,
        owner_programs: ownerPrograms,
      },
    };
  } catch {
    return { ok: false, degraded: true, error: "helius_unreachable" };
  }
}

export interface AssetMetadata {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  token_program: string | null;
}

/** OPTIONAL — on-chain metadata for the impersonation cross-check. */
async function fetchAssetMetadata(
  mint: string,
  fetchImpl: typeof fetch,
): Promise<SourceResult<AssetMetadata>> {
  const apiKey = process.env["HELIUS_API_KEY"];
  if (!apiKey) return { ok: false, error: "helius_not_configured" };
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`,
      OPTIONAL_TIMEOUT_MS,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAsset",
          params: { id: mint },
        }),
      },
    );
    if (!res.ok) return { ok: false, error: `get_asset_status_${res.status}` };
    const raw = (await res.json()) as RpcEnvelope;
    if (raw.error || raw.result === undefined) {
      return { ok: false, error: "get_asset_error" };
    }
    const result = raw.result as {
      content?: { metadata?: { name?: string; symbol?: string } };
      token_info?: { decimals?: number; token_program?: string };
    };
    return {
      ok: true,
      data: {
        name: result.content?.metadata?.name ?? null,
        symbol: result.content?.metadata?.symbol ?? null,
        decimals: result.token_info?.decimals ?? null,
        token_program: result.token_info?.token_program ?? null,
      },
      raw: result,
    };
  } catch {
    return { ok: false, error: "get_asset_unreachable" };
  }
}

export interface DexPairSummary {
  pair_count: number;
  max_pool_liquidity_usd: number | null;
  oldest_pair_created_at: string | null;
  pairs: unknown[];
}

/** OPTIONAL enrichment — degrades silently to stale_sources. */
async function fetchDexscreener(
  mint: string,
  fetchImpl: typeof fetch,
): Promise<SourceResult<DexPairSummary>> {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
      OPTIONAL_TIMEOUT_MS,
      {
        method: "GET",
        headers: { accept: "application/json", "user-agent": BROWSER_UA },
      },
    );
    if (!res.ok) return { ok: false, error: `dexscreener_status_${res.status}` };
    const raw = (await res.json()) as { pairs?: unknown[] | null };
    const pairs = Array.isArray(raw.pairs) ? raw.pairs : [];
    let maxLiq: number | null = null;
    let oldest: number | null = null;
    for (const p of pairs) {
      const liq = (p as { liquidity?: { usd?: number } })?.liquidity?.usd;
      if (typeof liq === "number" && (maxLiq === null || liq > maxLiq)) {
        maxLiq = liq;
      }
      const created = (p as { pairCreatedAt?: number })?.pairCreatedAt;
      if (typeof created === "number" && (oldest === null || created < oldest)) {
        oldest = created;
      }
    }
    return {
      ok: true,
      data: {
        pair_count: pairs.length,
        max_pool_liquidity_usd: maxLiq !== null ? round2(maxLiq) : null,
        oldest_pair_created_at:
          oldest !== null ? new Date(oldest).toISOString() : null,
        pairs: pairs.slice(0, RAW_ARRAY_CAP),
      },
      raw: { pair_count: pairs.length },
    };
  } catch {
    return { ok: false, error: "dexscreener_unreachable" };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Critical data + preflight (fail-closed gate)
// ─────────────────────────────────────────────────────────────────────

interface CriticalData {
  kind: "token_check_critical";
  mint: string;
  elite: EliteFlowData;
  jupToken: SourceResult<JupTokenInfo | null>;
  quote: SourceResult<QuoteData>;
  /**
   * Slow/optional fetches STARTED during preflight so their latency
   * overlaps on-chain settlement; never reject (failures resolve to
   * ok:false / degraded shapes).
   */
  holders: Promise<HoldersResult>;
  asset: Promise<SourceResult<AssetMetadata>>;
  dex: Promise<SourceResult<DexPairSummary>>;
}

function isCriticalData(v: unknown): v is CriticalData {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as CriticalData).kind === "token_check_critical"
  );
}

function parseMint(body: Buffer | null): string | null {
  if (!body || body.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const token = (parsed as Record<string, unknown>)["token"];
    if (typeof token !== "string" || !BASE58_RE.test(token)) return null;
    return token;
  } catch {
    return null;
  }
}

async function computeCriticalData(
  input: InternalHandlerInput,
  mint: string,
): Promise<
  | { ok: true; data: CriticalData }
  | { ok: false; source: string; error: string }
> {
  if (!input.db) {
    return { ok: false, source: "smart_money_db", error: "no_db_wired" };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const [elite, jupToken, quote] = await Promise.all([
    queryEliteFlow(input.db, mint, new Date()).then(
      (data) => ({ ok: true as const, data }),
      (err: unknown) => ({
        ok: false as const,
        error: `elite_query_failed: ${(err as Error).message ?? "unknown"}`,
      }),
    ),
    fetchJupToken(mint, fetchImpl),
    fetchJupQuote(mint, fetchImpl),
  ]);
  if (!elite.ok) {
    return { ok: false, source: "smart_money_db", error: elite.error };
  }
  if (!jupToken.ok) {
    return { ok: false, source: "jupiter_token_v2", error: jupToken.error };
  }
  if (!quote.ok) {
    return { ok: false, source: "jupiter_quote", error: quote.error };
  }
  // Kick off the degradable fetches WITHOUT awaiting — the dispatcher
  // settles the payment next, which absorbs the holder-chain long pole
  // (research §6: p50 589ms, max 1.6s).
  const holders = fetchHolderConcentration(mint, fetchImpl).catch(() => ({
    ok: false as const,
    degraded: true as const,
    error: "helius_unreachable",
  }));
  const asset = fetchAssetMetadata(mint, fetchImpl).catch(() => ({
    ok: false as const,
    error: "get_asset_unreachable",
  }));
  const dex = fetchDexscreener(mint, fetchImpl).catch(() => ({
    ok: false as const,
    error: "dexscreener_unreachable",
  }));
  return {
    ok: true,
    data: {
      kind: "token_check_critical",
      mint,
      elite: elite.data,
      jupToken,
      quote,
      holders,
      asset,
      dex,
    },
  };
}

/**
 * Pre-payment validator. Invalid JSON → 400; a missing or non-base58
 * `token` → 422. Either way the buyer never sees the 402 challenge
 * and never pays for a call that was always going to fail.
 */
export const tokenCheckValidator: InternalHandlerValidator = (
  body,
  _method,
) => {
  if (!body || body.length === 0) {
    return {
      status: 422,
      body: {
        error: "token_required",
        expected: '{"token":"<solana mint address>"}',
      },
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
      body: {
        error: "token_required",
        expected: '{"token":"<solana mint address>"}',
      },
    };
  }
  const token = (parsed as Record<string, unknown>)["token"];
  if (typeof token !== "string" || token.length === 0) {
    return { status: 422, body: { error: "token_required" } };
  }
  if (!BASE58_RE.test(token)) {
    return {
      status: 422,
      body: {
        error: "invalid_token_mint",
        detail: "token must be a base58 Solana mint address (32-44 chars)",
      },
    };
  }
  return null;
};

/**
 * Fail-closed gate, run by the dispatcher BEFORE the payment settles.
 * Proves the DB elite queries + Jupiter tokens/v2 + Jupiter quote by
 * running them in full; on success the result threads into the handler
 * as `preflightData` so nothing is fetched twice. On failure the buyer
 * gets a 503 and is NOT charged. (A "no route" quote and an
 * unknown-to-Jupiter mint both COUNT as computed — they are answers.)
 */
export const tokenCheckPreflight: InternalHandlerPreflight = async (input) => {
  const mint = parseMint(input.body);
  if (mint === null) {
    // The validator runs first in the dispatcher, so this is only a
    // belt-and-braces guard for direct invocation.
    return {
      status: 422,
      proceed: false,
      body: { error: "invalid_token_mint" },
    };
  }
  const critical = await computeCriticalData(input, mint);
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

export const tokenCheck: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  const rejected = tokenCheckValidator(input.body, input.method);
  if (rejected) return rejected;
  const mint = parseMint(input.body);
  if (mint === null) {
    return { status: 422, body: { error: "invalid_token_mint" } };
  }

  // Critical data: normally pre-computed by the preflight on this same
  // request. The recompute path covers direct invocation (tests, dev)
  // — if it fails here the buyer HAS paid, so this is a last-resort
  // 503, not the primary gate.
  let critical: CriticalData;
  if (isCriticalData(input.preflightData)) {
    critical = input.preflightData;
  } else {
    const computed = await computeCriticalData(input, mint);
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

  const [holders, asset, dex] = await Promise.all([
    critical.holders,
    critical.asset,
    critical.dex,
  ]);

  return {
    status: 200,
    body: buildTokenCheckResponse({
      mint: critical.mint,
      elite: critical.elite,
      jupToken: critical.jupToken,
      quote: critical.quote,
      holders,
      asset,
      dex,
      computedAt: new Date(),
    }),
  };
};

export interface BuildTokenCheckArgs {
  mint: string;
  elite: EliteFlowData;
  jupToken: SourceResult<JupTokenInfo | null>;
  quote: SourceResult<QuoteData>;
  holders: HoldersResult;
  asset: SourceResult<AssetMetadata>;
  dex: SourceResult<DexPairSummary>;
  computedAt: Date;
}

/** Pure assembly of the three-layer response — exported for tests. */
export function buildTokenCheckResponse(
  args: BuildTokenCheckArgs,
): Record<string, unknown> {
  const { mint, elite, jupToken, quote, holders, asset, dex, computedAt } =
    args;

  const jup = jupToken.ok ? jupToken.data : null;
  const quoteData = quote.ok ? quote.data : null;
  const audit: JupAudit | null = jup?.audit ?? null;

  // ── Liquidity axis (critical; always present)
  const impactPct = quoteData?.price_impact_pct ?? null;
  const liquidity = quoteData
    ? bucketLiquidity(quoteData.no_route ? null : impactPct)
    : null;

  // ── Concentration axis: RPC chain primary, jupiter_audit fallback.
  let concentrationSource: "rpc" | "jupiter_audit" | "unavailable";
  let walletHeldPct: number | null = null;
  let poolHeldPct: number | null = null;
  let concentration: ConcentrationBucket | null = null;
  if (holders.ok) {
    concentrationSource = "rpc";
    walletHeldPct = holders.data.wallet_held_top10_pct;
    poolHeldPct = holders.data.pool_held_top10_pct;
    concentration = bucketConcentration(walletHeldPct);
  } else if (typeof audit?.topHoldersPercentage === "number") {
    concentrationSource = "jupiter_audit";
    walletHeldPct = round2(audit.topHoldersPercentage);
    concentration = bucketConcentration(walletHeldPct);
  } else {
    concentrationSource = "unavailable";
  }

  // ── Age axis from firstPool.createdAt.
  const firstPoolAt = asDate(jup?.firstPool?.createdAt);
  const age = firstPoolAt !== null ? bucketAge(firstPoolAt, computedAt) : null;

  // ── Flags: authority + unknown_token + metadata_mismatch.
  const flags: TokenCheckFlag[] = deriveAuthorityFlags(audit);
  const unknownToken = jup === null && elite.card.trade_legs === 0;
  if (unknownToken) flags.push("unknown_token");
  if (quoteData?.no_route) flags.push("untradeable");
  const assetData = asset.ok ? asset.data : null;
  const jupSymbol = normalizeSymbol(jup?.symbol);
  const chainSymbol = normalizeSymbol(assetData?.symbol);
  if (
    jupSymbol !== null &&
    chainSymbol !== null &&
    jupSymbol !== chainSymbol
  ) {
    flags.push("metadata_mismatch");
  }

  // ── Momentum from stats24h.
  const stats24h = (jup?.stats24h ?? null) as Record<string, unknown> | null;
  const priceChange24h = numOrNull(stats24h?.["priceChange"]);
  const momentumLabel = deriveMomentumLabel(priceChange24h);

  const riskLevel = deriveRiskLevel({ liquidity, concentration, age, flags });

  // ── Degradations → stale_sources + confidence.
  const staleSources: string[] = [];
  if (!holders.ok) staleSources.push("helius_rpc_holders");
  if (!asset.ok) staleSources.push("helius_get_asset");
  if (!dex.ok) staleSources.push("dexscreener");
  const confidence = deriveTokenCheckConfidence(staleSources.length);

  const summary = buildTokenSummary({
    symbol: jup?.symbol ?? assetData?.symbol ?? null,
    riskLevel,
    liquidity,
    impactPct,
    concentration,
    walletHeldPct,
    age,
    flags,
    eliteStatus: elite.status,
    eliteCard: elite.status === "active" ? elite.card : null,
    staleSources,
  });

  return {
    token: mint,
    verdict: { risk_level: riskLevel, flags, summary, confidence },
    signals: {
      liquidity: {
        bucket: liquidity,
        price_impact_pct_500_usd: impactPct,
        no_route: quoteData?.no_route ?? null,
        quote_error_code: quoteData?.error_code ?? null,
      },
      concentration: {
        bucket: concentration,
        wallet_held_top10_pct: walletHeldPct,
        pool_held_top10_pct: poolHeldPct,
        source: concentrationSource,
        holders: holders.ok
          ? holders.data.holders.slice(0, RAW_ARRAY_CAP)
          : null,
      },
      age: {
        bucket: age,
        first_pool_created_at: firstPoolAt?.toISOString() ?? null,
      },
      authority: audit
        ? {
            mint_authority_disabled: audit.mintAuthorityDisabled ?? null,
            freeze_authority_disabled: audit.freezeAuthorityDisabled ?? null,
            dev_mints: audit.devMints ?? null,
          }
        : null,
      momentum: {
        label: momentumLabel,
        price_change_24h_pct: priceChange24h,
        holder_change_24h_pct: numOrNull(stats24h?.["holderChange"]),
        buy_volume_24h_usd: numOrNull(stats24h?.["buyVolume"]),
        sell_volume_24h_usd: numOrNull(stats24h?.["sellVolume"]),
        organic_score: jup?.organicScore ?? null,
        organic_score_label: jup?.organicScoreLabel ?? null,
      },
      elite_flow: {
        status: elite.status,
        card: elite.status === "active" ? elite.card : null,
        elite_feed_lag_hours: elite.elite_feed_lag_hours,
      },
    },
    data_quality: {
      stale_sources: staleSources,
      concentration_source: concentrationSource,
      computed_at: computedAt.toISOString(),
    },
    raw: {
      elite_flow: elite.card,
      jupiter_token: jup
        ? {
            ...jup,
            // tags is the only unbounded array on this payload.
            tags: Array.isArray(jup.tags)
              ? jup.tags.slice(0, RAW_ARRAY_CAP)
              : jup.tags,
          }
        : null,
      jupiter_quote: quote.ok ? capRawArrays(quote.raw) : null,
      holders: holders.ok ? holders.raw : null,
      get_asset: asset.ok ? asset.raw : null,
      dexscreener: dex.ok ? dex.data : null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────

function normalizeSymbol(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim().toLowerCase();
  return t.length > 0 ? t : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Cap any top-level array properties (routePlan etc.) at 20 entries. */
function capRawArrays(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return Array.isArray(raw) ? raw.slice(0, RAW_ARRAY_CAP) : raw;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] = Array.isArray(v) ? v.slice(0, RAW_ARRAY_CAP) : v;
  }
  return out;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}
