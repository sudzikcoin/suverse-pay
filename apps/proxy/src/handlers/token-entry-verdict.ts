/**
 * token-entry-verdict — ONE aggregated $0.50 enter-decision for a
 * Solana mint. Buyer POSTs { mint } and gets ENTER / CAUTION / AVOID,
 * combining three layers in a single call:
 *
 *   1. SAFETY (critical)      — the full token-check analysis, reused
 *      IN-PROCESS (tokenCheck + tokenCheckPreflight from
 *      token-check.ts). Its critical upstreams (smart-money DB +
 *      Jupiter tokens/v2 + Jupiter quote) gate settlement: if they are
 *      down the buyer is NOT charged.
 *   2. SMART-MONEY FLOW (non-critical, degrades) — fresh 24h + 7d
 *      per-mint netflow computed directly from sm_trades joined to
 *      eligible sm_wallets (the crypto-market-pulse NETFLOW_SQL
 *      pattern — sm_netflow_cache is FROZEN for short windows), plus
 *      30d context from sm_netflow_cache (the only window the tracker
 *      keeps fresh, per smart-money-rankings).
 *   3. LABEL CONTEXT (non-critical, degrades) — top <=10 distinct
 *      recent traders of the mint from sm_trades LEFT JOINed to
 *      sm_wallet_labels; counts by label class and a ring/bot
 *      dominance flag.
 *
 * DATA-FRESHNESS HONESTY: the Solana sm_trades tape has stalled before
 * (~1.5d, 2026-06). We SELECT the chain-wide max(timestamp) and the
 * mint-level max(timestamp); a tape older than 24h is reported in
 * data_quality.tape_freshness, pushed into stale_sources, and lowers
 * verdict confidence — a frozen tape must never read as "no flow".
 *
 * VERDICT RULES (deriveEntryVerdict, pure, documented at the fn):
 *   AVOID   — safety risk high/critical, OR strong smart net
 *             distribution in BOTH 24h and 7d windows.
 *   ENTER   — safety passes cleanly (risk low, zero flags) AND
 *             meaningful smart net accumulation (24h or 7d) AND no
 *             ring/bot dominance among recent traders (labels layer
 *             must be readable — unknowable dominance never ENTERs).
 *   CAUTION — everything else, including any degraded-flow read
 *             (safety-only calls floor at CAUTION, never ENTER).
 */
import type {
  DbQuerier,
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerPreflight,
  InternalHandlerResult,
  InternalHandlerValidator,
} from "./types.js";
import {
  classifyRequiredBase58Field,
  BASE58_RE,
  type InternalHandlerInputSchema,
} from "./discovery.js";
import {
  tokenCheck,
  tokenCheckPreflight,
  type RiskLevel,
} from "./token-check.js";

// ─────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────

const CHAIN = "solana";

// Hybrid eligibility gate — identical to token-check / crypto-market-
// pulse / wallet-reputation (workers/scoring eligibility.ts).
const ELIGIBLE_MIN_SCORE = 60;
const ELIGIBLE_MIN_CONFIDENCE = 50;
const EXCLUDED_WALLET_STATUSES = ["quarantined", "blacklisted"];

// Stable / quote mints — same solana set as crypto-market-pulse.
const STABLE_MINTS = [
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "So11111111111111111111111111111111111111112",
];

const WINDOW_HOURS = { "24h": 24, "7d": 168 } as const;
export type FlowWindow = keyof typeof WINDOW_HOURS;

/** The only sm_netflow_cache window the tracker keeps fresh. */
const CACHE_WINDOW = "30d";

// Verdict thresholds (USD net flow by eligible smart wallets).
const ENTER_MIN_NET_24H_USD = 250;
const ENTER_MIN_NET_7D_USD = 1_000;
const AVOID_MAX_NET_24H_USD = -500;
const AVOID_MAX_NET_7D_USD = -1_500;

// Tape honesty: chain-wide sm_trades max(timestamp) older than this →
// stale tape (Solana ingestion has stalled ~1.5d before).
const TAPE_STALE_AFTER_HOURS = 24;

// Label context: distinct recent traders window + cap.
const TRADER_WINDOW_DAYS = 7;
const TOP_TRADERS = 10;
// Ring/bot dominance: >=3 recent traders and >=50% flagged
// is_probable_bot (the labeler's coordinated/bot heuristic — the
// closest thing to "ring" the sm_wallet_labels taxonomy carries).
const BOT_DOMINANCE_MIN_TRADERS = 3;
const BOT_DOMINANCE_MIN_SHARE = 0.5;

/** raw layer serialized-size cap. */
const RAW_CAP_BYTES = 6 * 1024;

// ─────────────────────────────────────────────────────────────────────
// Input — { mint } required, base58 32-44
// ─────────────────────────────────────────────────────────────────────

export const tokenEntryVerdictInputSchema: InternalHandlerInputSchema = {
  method: "POST",
  content_type: "application/json",
  body: {
    type: "object",
    required: ["mint"],
    properties: {
      mint: {
        type: "string",
        description:
          "Solana token mint address to evaluate for entry (base58, 32-44 chars)",
        pattern: BASE58_RE.source,
      },
    },
  },
  example: { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
};

function parseMintField(body: Buffer | null): string | null {
  const c = classifyRequiredBase58Field(body, "mint");
  return c.kind === "valid" ? c.value : null;
}

/**
 * Discovery split (discovery.ts): empty / missing / placeholder mint
 * passes through (null) so crawlers reach the 402 challenge; a PRESENT
 * non-placeholder string failing base58 gets the 422 before the
 * challenge; invalid JSON stays 400. A PAID discovery-class body is
 * still stopped pre-settlement by the preflight.
 */
export const tokenEntryVerdictValidator: InternalHandlerValidator = (
  body,
  _method,
) => {
  const c = classifyRequiredBase58Field(body, "mint");
  switch (c.kind) {
    case "discovery":
    case "valid":
      return null;
    case "invalid_json":
      return { status: 400, body: { error: "invalid_json_body" } };
    case "malformed":
      return {
        status: 422,
        body: {
          error: "mint_required",
          expected: '{"mint":"<solana mint address>"}',
        },
      };
    case "invalid_value":
      return {
        status: 422,
        body: {
          error: "invalid_mint",
          detail: "mint must be a base58 Solana mint address (32-44 chars)",
          input_schema: tokenEntryVerdictInputSchema,
        },
      };
  }
};

// ─────────────────────────────────────────────────────────────────────
// Pure verdict logic — exported for unit tests
// ─────────────────────────────────────────────────────────────────────

export type EntryDecision = "ENTER" | "CAUTION" | "AVOID";
export type EntryConfidence = "low" | "medium" | "high";

export interface EntryFacts {
  /** token-check verdict.risk_level (null = defensively not-clean). */
  safety_risk_level: RiskLevel | null;
  /** token-check verdict.flags. */
  safety_flags: string[];
  /** token-check verdict.confidence ("low" counts as a degradation). */
  safety_confidence: string | null;
  netflow_24h_usd: number | null;
  netflow_7d_usd: number | null;
  netflow_30d_usd: number | null;
  /** false when the fresh sm_trades flow query failed this call. */
  flow_available: boolean;
  /** null when the label layer failed (unknowable ≠ false). */
  ring_or_bot_dominated: boolean | null;
  labels_available: boolean;
  /** chain tape older than 24h (or unreadable) — lowers confidence. */
  tape_stale: boolean;
}

export interface EntryVerdict {
  decision: EntryDecision;
  summary: string;
  confidence: EntryConfidence;
  decisive_factors: string[];
}

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "+";
  return `${sign}$${Math.abs(Math.round(n))}`;
}

/**
 * The decision table (documented in the file header):
 *
 *   1. safety high/critical                          → AVOID
 *   2. net <= -$500 (24h) AND net <= -$1500 (7d)     → AVOID
 *      (strong smart distribution in BOTH windows; requires a live
 *       flow read — a degraded flow can never produce an AVOID here)
 *   3. safety clean (risk low, zero flags) AND live flow with
 *      net >= +$250 (24h) OR net >= +$1000 (7d) AND labels readable
 *      with no ring/bot dominance                    → ENTER
 *   4. everything else                               → CAUTION
 *      (degraded flow / labels floor the call at CAUTION)
 *
 * Confidence: high with zero degradations; each of {flow unavailable,
 * labels unavailable, stale tape, safety confidence "low"} steps it
 * down (1 → medium, 2+ → low).
 */
export function deriveEntryVerdict(facts: EntryFacts): EntryVerdict {
  const degradations =
    (facts.flow_available ? 0 : 1) +
    (facts.labels_available ? 0 : 1) +
    (facts.tape_stale ? 1 : 0) +
    (facts.safety_confidence === "low" ? 1 : 0);
  const confidence: EntryConfidence =
    degradations === 0 ? "high" : degradations === 1 ? "medium" : "low";

  const risk = facts.safety_risk_level;
  const net24 = facts.netflow_24h_usd;
  const net7 = facts.netflow_7d_usd;

  // Rule 1 — safety veto, regardless of flow.
  if (risk === "high" || risk === "critical" || risk === null) {
    const factor =
      risk === null ? "safety_unreadable" : `safety_risk_${risk}`;
    const flagBit =
      facts.safety_flags.length > 0
        ? ` (${facts.safety_flags.join(", ")})`
        : "";
    return {
      decision: "AVOID",
      summary:
        `AVOID: token-check rates safety risk ${risk ?? "unknown"}${flagBit}, ` +
        `which overrides any smart-money flow signal.`,
      confidence,
      decisive_factors: [factor],
    };
  }

  // Rule 2 — strong distribution in BOTH windows (live flow only).
  if (
    facts.flow_available &&
    net24 !== null &&
    net7 !== null &&
    net24 <= AVOID_MAX_NET_24H_USD &&
    net7 <= AVOID_MAX_NET_7D_USD
  ) {
    return {
      decision: "AVOID",
      summary:
        `AVOID: smart wallets are strongly distributing this token ` +
        `(${fmtUsd(net24)} net 24h, ${fmtUsd(net7)} net 7d) even though safety risk is ${risk}.`,
      confidence,
      decisive_factors: ["smart_money_strong_distribution"],
    };
  }

  // Rule 3 — ENTER gate.
  const safetyClean = risk === "low" && facts.safety_flags.length === 0;
  const accumulation =
    facts.flow_available &&
    ((net24 !== null && net24 >= ENTER_MIN_NET_24H_USD) ||
      (net7 !== null && net7 >= ENTER_MIN_NET_7D_USD));
  const noDominance =
    facts.labels_available && facts.ring_or_bot_dominated === false;
  if (safetyClean && accumulation && noDominance) {
    return {
      decision: "ENTER",
      summary:
        `ENTER: safety is clean (risk low, no flags) and smart money is net ` +
        `accumulating (${net24 !== null ? fmtUsd(net24) : "n/a"} 24h, ` +
        `${net7 !== null ? fmtUsd(net7) : "n/a"} 7d) with no ring/bot ` +
        `dominance among recent traders.`,
      confidence,
      decisive_factors: [
        "safety_clean",
        "smart_money_accumulation",
        "no_ring_or_bot_dominance",
      ],
    };
  }

  // Rule 4 — CAUTION, naming what blocked ENTER.
  const reasons: string[] = [];
  const factors: string[] = [];
  if (!safetyClean) {
    reasons.push(
      `safety is not a clean pass (risk ${risk}` +
        (facts.safety_flags.length > 0
          ? `, flags: ${facts.safety_flags.join(", ")}`
          : "") +
        ")",
    );
    factors.push("safety_not_clean");
  }
  if (!facts.flow_available) {
    reasons.push("smart-money flow could not be read this call");
    factors.push("flow_unavailable");
  } else if (!accumulation) {
    reasons.push(
      `smart-money flow shows no meaningful accumulation ` +
        `(${net24 !== null ? fmtUsd(net24) : "n/a"} 24h, ${net7 !== null ? fmtUsd(net7) : "n/a"} 7d)`,
    );
    factors.push("no_meaningful_accumulation");
  }
  if (!facts.labels_available) {
    reasons.push("trader label context unavailable");
    factors.push("label_context_unavailable");
  } else if (facts.ring_or_bot_dominated === true) {
    reasons.push("recent traders are dominated by probable bots");
    factors.push("ring_or_bot_dominance");
  }
  if (facts.tape_stale) {
    reasons.push("the trade tape is stale (>24h old)");
    factors.push("stale_tape");
  }
  if (reasons.length === 0) {
    reasons.push("signals are mixed");
    factors.push("mixed_signals");
  }
  return {
    decision: "CAUTION",
    summary: `CAUTION: ${reasons.join("; ")}.`,
    confidence,
    decisive_factors: factors,
  };
}

// ─────────────────────────────────────────────────────────────────────
// DB queries — flow / 30d cache / trader labels / tape freshness
// ─────────────────────────────────────────────────────────────────────

// Fresh per-mint netflow straight from sm_trades (crypto-market-pulse
// NETFLOW_SQL pattern; sm_netflow_cache short windows are FROZEN).
// Buy = stable→mint leg, sell = mint→stable leg, eligible wallets only.
const MINT_FLOW_SQL = `
  WITH eligible AS (
    SELECT address FROM sm_wallets
     WHERE chain = $1
       AND score >= $2
       AND confidence_score >= $3
       AND NOT (status = ANY($4::text[]))
  )
  SELECT
    COALESCE(SUM(t.value_usd) FILTER (
      WHERE t.token_out = $5 AND t.token_in = ANY($6::text[])
    ), 0)::float8 AS buy_usd,
    COALESCE(SUM(t.value_usd) FILTER (
      WHERE t.token_in = $5 AND t.token_out = ANY($6::text[])
    ), 0)::float8 AS sell_usd,
    COUNT(DISTINCT t.wallet_address) FILTER (
      WHERE t.token_out = $5 AND t.token_in = ANY($6::text[])
    )::int AS distinct_buyers,
    COUNT(DISTINCT t.wallet_address) FILTER (
      WHERE t.token_in = $5 AND t.token_out = ANY($6::text[])
    )::int AS distinct_sellers,
    COUNT(*)::int AS trade_legs
  FROM sm_trades t
  JOIN eligible e ON e.address = t.wallet_address
  WHERE t.chain = $1
    AND t.tx_type = 'swap'
    AND t.value_usd IS NOT NULL
    AND t.value_usd > 0
    AND (t.token_in = $5 OR t.token_out = $5)
    AND t.timestamp >= $7
`;

// 30d context — the only trustworthy sm_netflow_cache window.
const CACHE_30D_SQL = `
  SELECT n.net_flow_usd::float8 AS net_flow_usd,
         n.buy_usd::float8 AS buy_usd,
         n.sell_usd::float8 AS sell_usd,
         n.smart_money_score::float8 AS smart_money_score,
         n.unique_traders, n.computed_at
    FROM sm_netflow_cache n
   WHERE n.chain = $1 AND n.time_window = $2 AND n.token_address = $3
   LIMIT 1
`;

// Top <=10 distinct recent traders of the mint + their entity labels.
const TRADER_LABELS_SQL = `
  WITH recent_traders AS (
    SELECT t.wallet_address,
           MAX(t.timestamp) AS last_trade_at,
           COUNT(*) AS legs
      FROM sm_trades t
     WHERE t.chain = $1
       AND t.tx_type = 'swap'
       AND (t.token_in = $2 OR t.token_out = $2)
       AND t.timestamp >= $3
     GROUP BY t.wallet_address
     ORDER BY MAX(t.timestamp) DESC
     LIMIT ${TOP_TRADERS}
  )
  SELECT rt.wallet_address, rt.last_trade_at, rt.legs,
         l.is_contract, l.is_cex_deposit, l.is_market_maker,
         l.is_deployer, l.is_lp_actor, l.is_probable_bot
    FROM recent_traders rt
    LEFT JOIN sm_wallet_labels l
      ON l.wallet_address = rt.wallet_address AND l.chain = $1
`;

// Tape honesty: chain-wide + mint-level max(timestamp) in one pass.
const TAPE_SQL = `
  SELECT
    MAX(t.timestamp) AS last_chain_trade_at,
    MAX(t.timestamp) FILTER (WHERE t.token_in = $2 OR t.token_out = $2)
      AS last_mint_trade_at
  FROM sm_trades t
  WHERE t.chain = $1
`;

export interface MintFlowWindowData {
  buy_usd: number;
  sell_usd: number;
  net_usd: number;
  distinct_buyers: number;
  distinct_sellers: number;
  trade_legs: number;
}

interface FlowData {
  w24: MintFlowWindowData;
  w7d: MintFlowWindowData;
}

interface Cache30dData {
  net_flow_usd: number | null;
  buy_usd: number | null;
  sell_usd: number | null;
  smart_money_score: number | null;
  unique_traders: number | null;
  computed_at: string | null;
}

interface TraderLabelRow {
  wallet_address: string;
  last_trade_at: string | null;
  legs: number | null;
  is_contract: boolean;
  is_cex_deposit: boolean;
  is_market_maker: boolean;
  is_deployer: boolean;
  is_lp_actor: boolean;
  is_probable_bot: boolean;
  labeled: boolean;
}

interface TapeData {
  last_chain_trade_at: string | null;
  last_mint_trade_at: string | null;
  hours_since_last_chain_trade: number | null;
  stale: boolean;
}

type Outcome<T> = { ok: true; data: T } | { ok: false; error: string };

async function queryFlowWindow(
  db: DbQuerier,
  mint: string,
  window: FlowWindow,
  now: Date,
): Promise<MintFlowWindowData> {
  const windowStart = new Date(
    now.getTime() - WINDOW_HOURS[window] * 3_600_000,
  );
  const { rows } = await db.query(MINT_FLOW_SQL, [
    CHAIN,
    ELIGIBLE_MIN_SCORE,
    ELIGIBLE_MIN_CONFIDENCE,
    EXCLUDED_WALLET_STATUSES,
    mint,
    STABLE_MINTS,
    windowStart,
  ]);
  const r = rows[0] ?? {};
  const buy = round2(Number(r["buy_usd"] ?? 0));
  const sell = round2(Number(r["sell_usd"] ?? 0));
  return {
    buy_usd: buy,
    sell_usd: sell,
    net_usd: round2(buy - sell),
    distinct_buyers: Number(r["distinct_buyers"] ?? 0),
    distinct_sellers: Number(r["distinct_sellers"] ?? 0),
    trade_legs: Number(r["trade_legs"] ?? 0),
  };
}

async function queryFlow(
  db: DbQuerier,
  mint: string,
  now: Date,
): Promise<FlowData> {
  const [w24, w7d] = await Promise.all([
    queryFlowWindow(db, mint, "24h", now),
    queryFlowWindow(db, mint, "7d", now),
  ]);
  return { w24, w7d };
}

async function queryCache30d(
  db: DbQuerier,
  mint: string,
): Promise<Cache30dData | null> {
  const { rows } = await db.query(CACHE_30D_SQL, [CHAIN, CACHE_WINDOW, mint]);
  const r = rows[0];
  if (!r) return null;
  return {
    net_flow_usd: numOrNull(r["net_flow_usd"]),
    buy_usd: numOrNull(r["buy_usd"]),
    sell_usd: numOrNull(r["sell_usd"]),
    smart_money_score: numOrNull(r["smart_money_score"]),
    unique_traders: numOrNull(r["unique_traders"]),
    computed_at: asIso(r["computed_at"]),
  };
}

function asBool(v: unknown): boolean {
  return v === true || v === "t" || v === "true";
}

async function queryTraderLabels(
  db: DbQuerier,
  mint: string,
  now: Date,
): Promise<TraderLabelRow[]> {
  const windowStart = new Date(
    now.getTime() - TRADER_WINDOW_DAYS * 86_400_000,
  );
  const { rows } = await db.query(TRADER_LABELS_SQL, [
    CHAIN,
    mint,
    windowStart,
  ]);
  return rows.map((r) => {
    const labeled =
      r["is_contract"] !== null &&
      r["is_contract"] !== undefined;
    return {
      wallet_address: String(r["wallet_address"]),
      last_trade_at: asIso(r["last_trade_at"]),
      legs: numOrNull(r["legs"]),
      is_contract: asBool(r["is_contract"]),
      is_cex_deposit: asBool(r["is_cex_deposit"]),
      is_market_maker: asBool(r["is_market_maker"]),
      is_deployer: asBool(r["is_deployer"]),
      is_lp_actor: asBool(r["is_lp_actor"]),
      is_probable_bot: asBool(r["is_probable_bot"]),
      labeled,
    };
  });
}

async function queryTape(
  db: DbQuerier,
  mint: string,
  now: Date,
): Promise<TapeData> {
  const { rows } = await db.query(TAPE_SQL, [CHAIN, mint]);
  const r = rows[0] ?? {};
  const chainLast = asDate(r["last_chain_trade_at"]);
  const hours =
    chainLast === null
      ? null
      : round2((now.getTime() - chainLast.getTime()) / 3_600_000);
  return {
    last_chain_trade_at: chainLast?.toISOString() ?? null,
    last_mint_trade_at: asIso(r["last_mint_trade_at"]),
    hours_since_last_chain_trade: hours,
    stale: hours === null || hours > TAPE_STALE_AFTER_HOURS,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Preflight — delegate the critical path to token-check (fail-closed)
// ─────────────────────────────────────────────────────────────────────

const CRITICAL_KIND = "token_entry_verdict_critical";

interface EntryCritical {
  kind: typeof CRITICAL_KIND;
  mint: string;
  /** tokenCheckPreflight's proven critical data, threaded verbatim. */
  token_check: unknown;
}

function isEntryCritical(v: unknown): v is EntryCritical {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as EntryCritical).kind === CRITICAL_KIND
  );
}

function tokenCheckBody(mint: string): Buffer {
  // token-check's input schema requires { token } (see
  // tokenCheckInputSchema) — translate our { mint } field.
  return Buffer.from(JSON.stringify({ token: mint }));
}

/**
 * Fail-closed gate. The safety layer is the critical path, so we run
 * tokenCheckPreflight in full (it proves the smart-money DB + Jupiter
 * tokens/v2 + Jupiter quote and starts the slow holder chain); its
 * failure is returned verbatim — 503/422 pass-through, buyer NOT
 * charged. Its data threads through so tokenCheck never redoes the
 * critical work. The flow/label/tape layers are non-critical and are
 * NOT gated here — they degrade in the handler.
 */
export const tokenEntryVerdictPreflight: InternalHandlerPreflight = async (
  input,
) => {
  const mint = parseMintField(input.body);
  if (mint === null) {
    // PAID discovery-class body (validator lets these reach the 402
    // challenge for crawlers) — 422, never settles.
    return {
      proceed: false,
      status: 422,
      body: {
        error: "invalid_mint",
        input_schema: tokenEntryVerdictInputSchema,
      },
    };
  }
  const pf = await tokenCheckPreflight({
    body: tokenCheckBody(mint),
    method: "POST",
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.db ? { db: input.db } : {}),
  });
  if (!pf.proceed) return pf;
  return {
    proceed: true,
    data: { kind: CRITICAL_KIND, mint, token_check: pf.data },
  };
};

// ─────────────────────────────────────────────────────────────────────
// The handler
// ─────────────────────────────────────────────────────────────────────

export const tokenEntryVerdict: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  const rejected = tokenEntryVerdictValidator(input.body, input.method);
  if (rejected) return rejected;
  const mint = parseMintField(input.body);
  if (mint === null) {
    return { status: 422, body: { error: "invalid_mint" } };
  }
  const now = new Date();

  // ── SAFETY layer: token-check in-process. Forward the preflight's
  // proven critical data so its Jupiter/DB work is not redone.
  let tcPreflightData: unknown;
  if (isEntryCritical(input.preflightData) && input.preflightData.mint === mint) {
    tcPreflightData = input.preflightData.token_check;
  }
  const tcRes = await tokenCheck({
    body: tokenCheckBody(mint),
    method: "POST",
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.db ? { db: input.db } : {}),
    ...(tcPreflightData !== undefined ? { preflightData: tcPreflightData } : {}),
  });
  if (tcRes.status !== 200) {
    // Critical layer failed post-payment (recompute path) — pass its
    // status through verbatim (503 retryable etc.).
    return tcRes;
  }
  const tcBody = tcRes.body as Record<string, unknown>;

  // ── Non-critical layers: each degrades independently.
  const db = input.db;
  const guard = async <T>(
    label: string,
    fn: (d: DbQuerier) => Promise<T>,
  ): Promise<Outcome<T>> => {
    if (!db) return { ok: false, error: `${label}: no_db_wired` };
    try {
      return { ok: true, data: await fn(db) };
    } catch (err) {
      return {
        ok: false,
        error: `${label}: ${(err as Error).message ?? "unknown"}`,
      };
    }
  };
  const [flow, cache30, labels, tape] = await Promise.all([
    guard("sm_trades_netflow", (d) => queryFlow(d, mint, now)),
    guard("sm_netflow_cache_30d", (d) => queryCache30d(d, mint)),
    guard("sm_wallet_labels", (d) => queryTraderLabels(d, mint, now)),
    guard("sm_trades_tape", (d) => queryTape(d, mint, now)),
  ]);

  return {
    status: 200,
    body: buildEntryVerdictResponse({
      mint,
      tokenCheckBody: tcBody,
      flow,
      cache30,
      labels,
      tape,
      computedAt: now,
    }),
  };
};

// ─────────────────────────────────────────────────────────────────────
// Response assembly — pure, exported for tests
// ─────────────────────────────────────────────────────────────────────

export interface BuildEntryVerdictArgs {
  mint: string;
  /** The 200 body returned by tokenCheck for this mint. */
  tokenCheckBody: Record<string, unknown>;
  flow: Outcome<FlowData>;
  cache30: Outcome<Cache30dData | null>;
  labels: Outcome<TraderLabelRow[]>;
  tape: Outcome<TapeData>;
  computedAt: Date;
}

export function buildEntryVerdictResponse(
  args: BuildEntryVerdictArgs,
): Record<string, unknown> {
  const { mint, tokenCheckBody: tc, flow, cache30, labels, tape, computedAt } =
    args;

  // ── Safety extraction (defensive — tc came from tokenCheck 200).
  const tcVerdict = (tc["verdict"] ?? {}) as Record<string, unknown>;
  const riskRaw = tcVerdict["risk_level"];
  const safetyRisk: RiskLevel | null =
    riskRaw === "low" ||
    riskRaw === "moderate" ||
    riskRaw === "high" ||
    riskRaw === "critical"
      ? riskRaw
      : null;
  const safetyFlags = Array.isArray(tcVerdict["flags"])
    ? (tcVerdict["flags"] as unknown[]).map(String)
    : [];
  const safetyConfidence =
    typeof tcVerdict["confidence"] === "string"
      ? tcVerdict["confidence"]
      : null;

  // ── Flow layer.
  const flowData = flow.ok ? flow.data : null;
  const net24 = flowData ? flowData.w24.net_usd : null;
  const net7 = flowData ? flowData.w7d.net_usd : null;
  const cacheData = cache30.ok ? cache30.data : null;
  const net30 = cacheData?.net_flow_usd ?? null;
  const direction: "accumulation" | "distribution" | "neutral" | "unknown" =
    !flowData
      ? "unknown"
      : (net24 !== null && net24 >= ENTER_MIN_NET_24H_USD) ||
          (net7 !== null && net7 >= ENTER_MIN_NET_7D_USD)
        ? "accumulation"
        : (net24 !== null && net24 <= AVOID_MAX_NET_24H_USD) ||
            (net7 !== null && net7 <= AVOID_MAX_NET_7D_USD)
          ? "distribution"
          : "neutral";

  // ── Label context.
  const labelRows = labels.ok ? labels.data : null;
  let labeledShare: number | null = null;
  let labelCounts: Record<string, number> | null = null;
  let dominated: boolean | null = null;
  if (labelRows !== null) {
    const total = labelRows.length;
    const counts: Record<string, number> = {
      contract: 0,
      cex_deposit: 0,
      market_maker: 0,
      deployer: 0,
      lp_actor: 0,
      probable_bot: 0,
      unlabeled: 0,
    };
    let labeledCount = 0;
    let botCount = 0;
    for (const r of labelRows) {
      if (!r.labeled) {
        counts["unlabeled"] = (counts["unlabeled"] ?? 0) + 1;
        continue;
      }
      labeledCount += 1;
      if (r.is_contract) counts["contract"] = (counts["contract"] ?? 0) + 1;
      if (r.is_cex_deposit) {
        counts["cex_deposit"] = (counts["cex_deposit"] ?? 0) + 1;
      }
      if (r.is_market_maker) {
        counts["market_maker"] = (counts["market_maker"] ?? 0) + 1;
      }
      if (r.is_deployer) counts["deployer"] = (counts["deployer"] ?? 0) + 1;
      if (r.is_lp_actor) counts["lp_actor"] = (counts["lp_actor"] ?? 0) + 1;
      if (r.is_probable_bot) {
        counts["probable_bot"] = (counts["probable_bot"] ?? 0) + 1;
        botCount += 1;
      }
    }
    labelCounts = counts;
    labeledShare = total > 0 ? round2(labeledCount / total) : null;
    dominated =
      total >= BOT_DOMINANCE_MIN_TRADERS &&
      botCount / total >= BOT_DOMINANCE_MIN_SHARE;
  }

  // ── Tape freshness (unreadable tape treated as stale — conservative).
  const tapeData = tape.ok ? tape.data : null;
  const tapeStale = tapeData ? tapeData.stale : true;

  // ── Degradations → stale_sources + windows_used.
  const staleSources: string[] = [];
  if (!flow.ok) staleSources.push("sm_trades_netflow");
  if (!cache30.ok) staleSources.push("sm_netflow_cache_30d");
  if (!labels.ok) staleSources.push("sm_wallet_labels");
  if (!tape.ok) staleSources.push("sm_trades_tape");
  else if (tapeData?.stale) staleSources.push("stale_tape");
  const windowsUsed: string[] = [];
  if (flow.ok) windowsUsed.push("24h", "7d");
  if (cache30.ok && cacheData !== null) windowsUsed.push("30d");

  const verdict = deriveEntryVerdict({
    safety_risk_level: safetyRisk,
    safety_flags: safetyFlags,
    safety_confidence: safetyConfidence,
    netflow_24h_usd: net24,
    netflow_7d_usd: net7,
    netflow_30d_usd: net30,
    flow_available: flow.ok,
    ring_or_bot_dominated: dominated,
    labels_available: labels.ok,
    tape_stale: tapeStale,
  });

  return {
    mint,
    verdict: {
      decision: verdict.decision,
      summary: verdict.summary,
      confidence: verdict.confidence,
      decisive_factors: verdict.decisive_factors,
    },
    signals: {
      safety: {
        verdict: safetyRisk,
        flags: safetyFlags,
        confidence: safetyConfidence,
        summary:
          typeof tcVerdict["summary"] === "string"
            ? tcVerdict["summary"]
            : null,
      },
      smart_money: {
        netflow_24h_usd: net24,
        netflow_7d_usd: net7,
        netflow_30d_usd: net30,
        distinct_smart_buyers_24h: flowData?.w24.distinct_buyers ?? null,
        distinct_smart_sellers_24h: flowData?.w24.distinct_sellers ?? null,
        direction,
      },
      trader_context: {
        traders_considered: labelRows?.length ?? null,
        labeled_share: labeledShare,
        label_counts: labelCounts,
        ring_or_bot_dominated: dominated,
      },
    },
    data_quality: {
      tape_freshness: {
        last_chain_trade_at: tapeData?.last_chain_trade_at ?? null,
        last_mint_trade_at: tapeData?.last_mint_trade_at ?? null,
        hours_since_last_chain_trade:
          tapeData?.hours_since_last_chain_trade ?? null,
        stale: tapeStale,
      },
      stale_sources: staleSources,
      windows_used: windowsUsed,
      computed_at: computedAt.toISOString(),
    },
    raw: capRawLayer({
      token_check: tc,
      netflow_rows: {
        fresh_24h: flowData?.w24 ?? null,
        fresh_7d: flowData?.w7d ?? null,
        cache_30d: cacheData ?? null,
      },
      label_rows: labelRows ?? null,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Raw-layer size cap (<= 6KB serialized)
// ─────────────────────────────────────────────────────────────────────

function serializedBytes(v: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(v) ?? "null", "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Progressive trim: (1) drop token_check's own raw sub-layer, (2) keep
 * only token_check verdict+data_quality and cap label rows, (3) final
 * fallback to a tiny truncation notice. Never exceeds RAW_CAP_BYTES.
 */
function capRawLayer(raw: Record<string, unknown>): unknown {
  if (serializedBytes(raw) <= RAW_CAP_BYTES) return raw;
  const tc = raw["token_check"];
  const tcObj =
    tc !== null && typeof tc === "object"
      ? (tc as Record<string, unknown>)
      : null;
  let out: Record<string, unknown> = {
    ...raw,
    token_check: tcObj ? { ...tcObj, raw: "omitted_for_size" } : tc,
  };
  if (serializedBytes(out) <= RAW_CAP_BYTES) return out;
  out = {
    ...out,
    token_check: tcObj
      ? {
          token: tcObj["token"] ?? null,
          verdict: tcObj["verdict"] ?? null,
          data_quality: tcObj["data_quality"] ?? null,
          signals: "omitted_for_size",
          raw: "omitted_for_size",
        }
      : tc,
    label_rows: Array.isArray(out["label_rows"])
      ? (out["label_rows"] as unknown[]).slice(0, 3)
      : out["label_rows"],
  };
  if (serializedBytes(out) <= RAW_CAP_BYTES) return out;
  return {
    truncated: true,
    note: `raw layer exceeded the ${RAW_CAP_BYTES}-byte cap and was dropped`,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function asIso(v: unknown): string | null {
  return asDate(v)?.toISOString() ?? null;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
