/**
 * Crypto Market Pulse — ONE aggregated verdict from five sources the
 * catalog already sells separately. Buyer pays $0.10 and gets:
 *
 *   verdict      — regime + 2-3 sentence summary + confidence
 *   signals      — the per-source axes the verdict was derived from
 *   data_quality — per-chain coverage + which sources were stale
 *   raw          — all five source responses verbatim
 *
 * The verdict crosses two axes (cmp-research report, 2026-06-10):
 *   Axis A — fear-greed classification bucketed to fear/neutral/greed.
 *   Axis B — smart-money netflow direction computed ON THE FLY from
 *            sm_trades (sm_netflow_cache is stale for 1h/24h/7d
 *            windows — research §3a), summing per-token net_flow_usd
 *            over tokens whose flow-weighted smart_money_score >= 70.
 *
 * Fail-closed: the verdict is impossible without fear-greed + netflow,
 * so `cryptoMarketPulsePreflight` proves both BEFORE the payment
 * settles (the dispatcher runs it pre-runProtocol). Trending / BTC /
 * Polymarket are enrichment — when one fails the call still succeeds,
 * the signal is omitted, the source is listed in
 * `data_quality.stale_sources`, and confidence degrades.
 *
 * Polymarket gating: bias_score is bimodal at ±100 (clamps whenever
 * one side has zero smart volume — research §3b) and is deliberately
 * IGNORED. A market counts as a signal only when conviction_score
 * >= 60 (p75 of the live distribution); we return at most the top 3.
 */
import { fearGreedIndex } from "./fear-greed-index.js";
import { coingeckoTrending } from "./coingecko-trending.js";
import type {
  DbQuerier,
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerPreflight,
  InternalHandlerResult,
  InternalHandlerValidator,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────
// Tunables — all empirically derived in the cmp-research report.
// ─────────────────────────────────────────────────────────────────────

/** Per-token flow-weighted score floor for the netflow axis sum. */
const NETFLOW_SCORE_FLOOR = 70;
/** Polymarket conviction gate (p75 of poly_smart_bias_cache). */
const CONVICTION_GATE = 60;
/** Max polymarket markets surfaced as signals. */
const POLYMARKET_TOP_N = 3;
/** Trending coins cross-checked against smart-money flow. */
const TRENDING_TOP_N = 7;
/** Solana eligible-row floor for "high" confidence. */
const HIGH_CONFIDENCE_MIN_ROWS = 10;

const CHAINS = ["solana", "base"] as const;
export type PulseChain = (typeof CHAINS)[number];

/**
 * Per-chain data maturity, mirrored from the smart-money API's
 * `meta.coverage_level` (solana calibrated 2026-06-03; base still
 * uncalibrated). The OVERALL regime comes from the production chain.
 */
export const CHAIN_COVERAGE: Record<PulseChain, string> = {
  solana: "production",
  base: "beta",
};
const PRODUCTION_CHAIN: PulseChain = "solana";

const WINDOW_HOURS = { "24h": 24, "7d": 168 } as const;
export type PulseWindow = keyof typeof WINDOW_HOURS;

// Wallet eligibility — same hybrid gate the smart-money API applies
// (workers/scoring eligibility.ts): score >= 60, confidence >= 50,
// quarantined/blacklisted never surface.
const ELIGIBLE_MIN_SCORE = 60;
const ELIGIBLE_MIN_CONFIDENCE = 50;
const EXCLUDED_WALLET_STATUSES = ["quarantined", "blacklisted"];

// Stable / quote mints excluded from the volatile-leg attribution —
// copied from smart-money-tracker api/src/netflow-query.ts so our
// on-the-fly sums agree with the standalone netflow endpoint.
const STABLE_MINTS: Record<PulseChain, string[]> = {
  solana: [
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    "So11111111111111111111111111111111111111112",
  ],
  base: [
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca",
    "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2",
    "0x4200000000000000000000000000000000000006",
  ],
};

const UPSTREAM_TIMEOUT_MS = 8_000;

function polymarketApiBase(): string {
  return process.env["POLYMARKET_API_URL"] ?? "http://127.0.0.1:3400";
}

// ─────────────────────────────────────────────────────────────────────
// Verdict logic — pure, exported for unit tests.
// ─────────────────────────────────────────────────────────────────────

export type SentimentBucket = "fear" | "neutral" | "greed";
export type FlowDirection = "inflow" | "outflow" | "neutral";
export type Regime =
  | "accumulation_on_fear"
  | "capitulation"
  | "confirmed_rally"
  | "late_stage_caution"
  | "mixed";

/**
 * Axis A: alternative.me classification → 3-way bucket. The upstream
 * enum is closed (Extreme Fear | Fear | Neutral | Greed | Extreme
 * Greed); anything unrecognized defensively maps to neutral.
 */
export function bucketSentiment(classification: string | null): SentimentBucket {
  const c = (classification ?? "").toLowerCase();
  if (c === "extreme fear" || c === "fear") return "fear";
  if (c === "greed" || c === "extreme greed") return "greed";
  return "neutral";
}

/**
 * Axis B: direction from the 24h/7d eligible-token sums.
 * pace = sum / window hours (USD per hour).
 *   inflow  — 24h sum > 0 AND 24h pace >= 7d pace
 *   outflow — 24h sum < 0 AND |24h pace| >= 7d pace
 *   neutral — everything else (flat 24h, or 24h flow decelerating
 *             relative to the week).
 */
export function deriveDirection(
  sum24h: number,
  sum7d: number,
): { direction: FlowDirection; pace24h: number; pace7d: number } {
  const pace24h = sum24h / WINDOW_HOURS["24h"];
  const pace7d = sum7d / WINDOW_HOURS["7d"];
  let direction: FlowDirection = "neutral";
  if (sum24h > 0 && pace24h >= pace7d) direction = "inflow";
  else if (sum24h < 0 && Math.abs(pace24h) >= pace7d) direction = "outflow";
  return { direction, pace24h, pace7d };
}

/** The 3x3 regime grid. Any neutral axis collapses to "mixed". */
export function deriveRegime(
  sentiment: SentimentBucket,
  direction: FlowDirection,
): Regime {
  if (sentiment === "fear" && direction === "inflow") {
    return "accumulation_on_fear";
  }
  if (sentiment === "fear" && direction === "outflow") return "capitulation";
  if (sentiment === "greed" && direction === "inflow") {
    return "confirmed_rally";
  }
  if (sentiment === "greed" && direction === "outflow") {
    return "late_stage_caution";
  }
  return "mixed";
}

export interface NetflowTokenRow {
  token_address: string;
  symbol: string | null;
  net_flow_usd: number;
  gross_flow_usd: number;
  smart_money_score: number;
  trade_count: number;
}

export interface ChainWindowNetflow {
  rows: NetflowTokenRow[];
  /** Σ net_flow_usd over rows with smart_money_score >= 70. */
  eligible_sum_net_flow_usd: number;
  eligible_row_count: number;
}

export type NetflowByChain = Record<
  PulseChain,
  Record<PulseWindow, ChainWindowNetflow>
>;

export interface PolymarketMarket {
  market_id?: string;
  market_title?: string | null;
  category?: string;
  conviction_score?: number;
  smart_yes_volume_usd?: number;
  smart_no_volume_usd?: number;
  bias_score?: number;
  [k: string]: unknown;
}

/**
 * Gate + rank the polymarket markets: conviction_score >= 60 only
 * (bias_score is deliberately ignored — bimodal at ±100), top 3 by
 * conviction descending.
 */
export function filterPolymarketSignals(
  markets: PolymarketMarket[],
): PolymarketMarket[] {
  return markets
    .filter(
      (m) =>
        typeof m.conviction_score === "number" &&
        m.conviction_score >= CONVICTION_GATE,
    )
    .sort((a, b) => (b.conviction_score ?? 0) - (a.conviction_score ?? 0))
    .slice(0, POLYMARKET_TOP_N);
}

export interface TrendingCoin {
  id?: string | null;
  symbol?: string | null;
  name?: string | null;
  market_cap_rank?: number | null;
  [k: string]: unknown;
}

/**
 * Trending cross-check: a top-7 trending coin is `confirmed` when its
 * symbol shows up in ANY netflow row (either chain, either window)
 * with positive net_flow_usd — i.e. the retail attention has
 * smart-money buying behind it. Case-insensitive symbol match.
 */
export function crossCheckTrending(
  coins: TrendingCoin[],
  netflow: NetflowByChain,
): Array<TrendingCoin & { confirmed: boolean }> {
  const positive = new Set<string>();
  for (const chain of CHAINS) {
    for (const window of Object.keys(WINDOW_HOURS) as PulseWindow[]) {
      for (const row of netflow[chain][window].rows) {
        if (row.symbol && row.net_flow_usd > 0) {
          positive.add(row.symbol.toLowerCase());
        }
      }
    }
  }
  return coins.slice(0, TRENDING_TOP_N).map((c) => ({
    ...c,
    confirmed:
      typeof c.symbol === "string" && c.symbol.length > 0
        ? positive.has(c.symbol.toLowerCase())
        : false,
  }));
}

const REGIME_PHRASE: Record<Regime, string> = {
  accumulation_on_fear:
    "smart money is accumulating into the fear, a historically contrarian-bullish setup",
  capitulation:
    "smart money is exiting alongside the fear, consistent with capitulation",
  confirmed_rally:
    "smart-money inflows are confirming the greed, a momentum-supported rally",
  late_stage_caution:
    "smart money is selling into the greed, a late-stage caution signal",
  mixed: "smart-money flows do not clearly confirm or contradict it",
};

export interface VerdictInput {
  classification: string | null;
  currentValue: number | null;
  sentiment: SentimentBucket;
  direction: FlowDirection;
  regime: Regime;
  confirmedTrending: number;
  totalTrending: number;
  polymarketSignals: number;
  staleSources: string[];
}

/** 2-3 plain-English sentences a non-quant agent can act on. */
export function buildSummary(v: VerdictInput): string {
  const flowPhrase =
    v.direction === "inflow"
      ? "net buyers over the last 24 hours"
      : v.direction === "outflow"
        ? "net sellers over the last 24 hours"
        : "neither clearly buying nor selling over the last 24 hours";
  const first =
    `Market sentiment is ${v.classification ?? "unknown"}` +
    (v.currentValue !== null ? ` (${v.currentValue}/100)` : "") +
    ` and tracked smart-money wallets are ${flowPhrase}, so ${REGIME_PHRASE[v.regime]}.`;
  const second =
    `${v.confirmedTrending} of the top ${v.totalTrending} trending coins ` +
    `have positive smart-money netflow behind the hype` +
    (v.polymarketSignals > 0
      ? `, and ${v.polymarketSignals} Polymarket market${v.polymarketSignals === 1 ? " shows" : "s show"} high-conviction smart positioning.`
      : ", and no Polymarket market currently clears the high-conviction bar.");
  const third =
    v.staleSources.length > 0
      ? ` Note: ${v.staleSources.join(", ")} unavailable for this read, so confidence is reduced.`
      : "";
  return `${first} ${second}${third}`;
}

export type Confidence = "low" | "medium" | "high";

/**
 * high   — zero degraded signals AND the production chain (solana)
 *          had >= 10 distinct eligible tokens feeding the axis.
 * medium — exactly one degraded signal (a failed optional source, or
 *          thin solana coverage).
 * low    — anything worse.
 */
export function deriveConfidence(
  failedSources: string[],
  solanaEligibleRows: number,
): Confidence {
  const degraded =
    failedSources.length + (solanaEligibleRows >= HIGH_CONFIDENCE_MIN_ROWS ? 0 : 1);
  if (degraded === 0) return "high";
  if (degraded === 1) return "medium";
  return "low";
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
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface FearGreedBody {
  current_value: number | null;
  classification: string | null;
  [k: string]: unknown;
}

/** Reuses the standalone fear_greed_index handler so shapes stay identical. */
async function fetchFearGreed(
  input: InternalHandlerInput,
): Promise<SourceResult<FearGreedBody>> {
  const res = await fearGreedIndex({
    body: null,
    method: "POST",
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  if (res.status !== 200) {
    return { ok: false, error: `fear_greed_status_${res.status}` };
  }
  return { ok: true, data: res.body as FearGreedBody, raw: res.body };
}

interface TrendingBody {
  count: number;
  coins: TrendingCoin[];
}

/** Reuses the standalone coingecko_trending handler. */
async function fetchTrending(
  input: InternalHandlerInput,
): Promise<SourceResult<TrendingBody>> {
  const res = await coingeckoTrending({
    body: null,
    method: "POST",
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  if (res.status !== 200) {
    return { ok: false, error: `trending_status_${res.status}` };
  }
  return { ok: true, data: res.body as TrendingBody, raw: res.body };
}

interface BtcQuote {
  price_usd: number;
  change_24h_pct: number | null;
  source: "coingecko" | "coinbase_spot";
}

/**
 * CoinGecko simple/price with include_24hr_change=true is primary —
 * Coinbase spot has no delta and stringifies the amount, so it is
 * price-only fallback (change_24h_pct comes back null and the source
 * is reported as degraded).
 */
async function fetchBtc(
  input: InternalHandlerInput,
): Promise<SourceResult<BtcQuote>> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",
      { method: "GET", headers: { accept: "application/json" } },
    );
    if (res.ok) {
      const raw = (await res.json()) as {
        bitcoin?: { usd?: number; usd_24h_change?: number };
      };
      const price = raw.bitcoin?.usd;
      if (typeof price === "number") {
        return {
          ok: true,
          data: {
            price_usd: price,
            change_24h_pct:
              typeof raw.bitcoin?.usd_24h_change === "number"
                ? round2(raw.bitcoin.usd_24h_change)
                : null,
            source: "coingecko",
          },
          raw,
        };
      }
    }
  } catch {
    // fall through to Coinbase
  }
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      "https://api.coinbase.com/v2/prices/BTC-USD/spot",
      { method: "GET", headers: { accept: "application/json" } },
    );
    if (res.ok) {
      const raw = (await res.json()) as { data?: { amount?: string } };
      const price = Number.parseFloat(raw.data?.amount ?? "");
      if (Number.isFinite(price)) {
        return {
          ok: true,
          data: { price_usd: price, change_24h_pct: null, source: "coinbase_spot" },
          raw,
        };
      }
    }
  } catch {
    // both upstreams failed
  }
  return { ok: false, error: "btc_unavailable" };
}

async function fetchPolymarket(
  input: InternalHandlerInput,
): Promise<SourceResult<PolymarketMarket[]>> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${polymarketApiBase()}/v1/polymarket/smart-bias`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ time_window: "24h", limit: 50 }),
      },
    );
    if (!res.ok) {
      return { ok: false, error: `polymarket_status_${res.status}` };
    }
    const raw = (await res.json()) as { data?: PolymarketMarket[] };
    if (!Array.isArray(raw.data)) {
      return { ok: false, error: "polymarket_bad_shape" };
    }
    return { ok: true, data: raw.data, raw };
  } catch {
    return { ok: false, error: "polymarket_unreachable" };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Netflow — computed on the fly from sm_trades (NOT sm_netflow_cache,
// which is frozen for the 1h/24h/7d windows; cmp-research §3a).
// ─────────────────────────────────────────────────────────────────────

const NETFLOW_SQL = `
  WITH eligible AS (
    SELECT address, score FROM sm_wallets
     WHERE chain = $1
       AND score >= $2
       AND confidence_score >= $3
       AND NOT (status = ANY($4::text[]))
  ),
  swap_legs AS (
    SELECT
      CASE
        WHEN t.token_out IS NOT NULL AND NOT (t.token_out = ANY($5::text[]))
          THEN t.token_out
        WHEN t.token_in IS NOT NULL AND NOT (t.token_in = ANY($5::text[]))
          THEN t.token_in
      END AS volatile_mint,
      CASE
        WHEN t.token_out IS NOT NULL
             AND NOT (t.token_out = ANY($5::text[]))
             AND t.token_in = ANY($5::text[])
          THEN 'buy'
        WHEN t.token_in IS NOT NULL
             AND NOT (t.token_in = ANY($5::text[]))
             AND t.token_out = ANY($5::text[])
          THEN 'sell'
        ELSE 'neutral'
      END AS side,
      t.value_usd,
      e.score
    FROM sm_trades t
    JOIN eligible e ON e.address = t.wallet_address
    WHERE t.chain = $1
      AND t.tx_type = 'swap'
      AND t.value_usd IS NOT NULL
      AND t.value_usd > 0
      AND t.timestamp >= $6
  ),
  per_token AS (
    SELECT
      volatile_mint AS token_address,
      SUM(CASE WHEN side = 'buy'  THEN value_usd ELSE 0 END) AS buy_usd,
      SUM(CASE WHEN side = 'sell' THEN value_usd ELSE 0 END) AS sell_usd,
      SUM(value_usd) AS gross_flow_usd,
      COUNT(*) AS trade_count,
      SUM(score * value_usd) AS w_score_sum,
      SUM(value_usd) AS w_sum
    FROM swap_legs
    WHERE volatile_mint IS NOT NULL
    GROUP BY volatile_mint
  )
  SELECT
    pt.token_address,
    mc.symbol,
    (pt.buy_usd - pt.sell_usd)::float8 AS net_flow_usd,
    pt.gross_flow_usd::float8 AS gross_flow_usd,
    CASE WHEN pt.w_sum > 0 THEN (pt.w_score_sum / pt.w_sum)::float8 ELSE 0 END
      AS smart_money_score,
    pt.trade_count::int AS trade_count
  FROM per_token pt
  LEFT JOIN sm_token_metadata_cache mc
    ON mc.token_address = pt.token_address AND mc.chain = $1
  ORDER BY pt.gross_flow_usd DESC
`;

async function queryChainWindowNetflow(
  db: DbQuerier,
  chain: PulseChain,
  window: PulseWindow,
  now: Date,
): Promise<ChainWindowNetflow> {
  const windowStart = new Date(
    now.getTime() - WINDOW_HOURS[window] * 60 * 60 * 1000,
  );
  const { rows } = await db.query(NETFLOW_SQL, [
    chain,
    ELIGIBLE_MIN_SCORE,
    ELIGIBLE_MIN_CONFIDENCE,
    EXCLUDED_WALLET_STATUSES,
    STABLE_MINTS[chain],
    windowStart,
  ]);
  const mapped: NetflowTokenRow[] = rows.map((r) => ({
    token_address: String(r["token_address"]),
    symbol: (r["symbol"] as string | null) ?? null,
    net_flow_usd: round2(Number(r["net_flow_usd"])),
    gross_flow_usd: round2(Number(r["gross_flow_usd"])),
    smart_money_score: round2(Number(r["smart_money_score"])),
    trade_count: Number(r["trade_count"]),
  }));
  const eligibleRows = mapped.filter(
    (r) => r.smart_money_score >= NETFLOW_SCORE_FLOOR,
  );
  return {
    rows: mapped,
    eligible_sum_net_flow_usd: round2(
      eligibleRows.reduce((acc, r) => acc + r.net_flow_usd, 0),
    ),
    eligible_row_count: eligibleRows.length,
  };
}

async function queryNetflow(db: DbQuerier, now: Date): Promise<NetflowByChain> {
  const jobs: Array<Promise<[PulseChain, PulseWindow, ChainWindowNetflow]>> = [];
  for (const chain of CHAINS) {
    for (const window of Object.keys(WINDOW_HOURS) as PulseWindow[]) {
      jobs.push(
        queryChainWindowNetflow(db, chain, window, now).then((res) => [
          chain,
          window,
          res,
        ]),
      );
    }
  }
  const results = await Promise.all(jobs);
  const out = {
    solana: {},
    base: {},
  } as NetflowByChain;
  for (const [chain, window, res] of results) {
    out[chain][window] = res;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Critical sources + preflight (fail-closed gate)
// ─────────────────────────────────────────────────────────────────────

interface CriticalSources {
  kind: "crypto_market_pulse_critical";
  fearGreed: FearGreedBody;
  netflow: NetflowByChain;
}

function isCriticalSources(v: unknown): v is CriticalSources {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as CriticalSources).kind === "crypto_market_pulse_critical"
  );
}

async function computeCriticalSources(
  input: InternalHandlerInput,
): Promise<
  | { ok: true; data: CriticalSources }
  | { ok: false; source: string; error: string }
> {
  if (!input.db) {
    return { ok: false, source: "smart_money_netflow", error: "no_db_wired" };
  }
  const [fearGreed, netflow] = await Promise.all([
    fetchFearGreed(input),
    queryNetflow(input.db, new Date()).then(
      (data) => ({ ok: true as const, data }),
      (err: unknown) => ({
        ok: false as const,
        error: `netflow_query_failed: ${(err as Error).message ?? "unknown"}`,
      }),
    ),
  ]);
  if (!fearGreed.ok) {
    return { ok: false, source: "fear_greed", error: fearGreed.error };
  }
  if (!netflow.ok) {
    return { ok: false, source: "smart_money_netflow", error: netflow.error };
  }
  return {
    ok: true,
    data: {
      kind: "crypto_market_pulse_critical",
      fearGreed: fearGreed.data,
      netflow: netflow.data,
    },
  };
}

/** Accepts an empty body or any JSON object; rejects everything else. */
export const cryptoMarketPulseValidator: InternalHandlerValidator = (
  body,
  _method,
) => {
  if (!body || body.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {
        status: 400,
        body: { error: "invalid_body", expected: "empty body or JSON object" },
      };
    }
    return null;
  } catch {
    return { status: 400, body: { error: "invalid_json_body" } };
  }
};

/**
 * Fail-closed gate, run by the dispatcher BEFORE the payment settles.
 * The two sources the verdict cannot exist without (fear-greed +
 * sm_trades netflow) are computed here in full; on success the result
 * is threaded into the handler as `preflightData` so nothing is
 * fetched twice. On failure the buyer gets a 503 and is NOT charged.
 */
export const cryptoMarketPulsePreflight: InternalHandlerPreflight = async (
  input,
) => {
  const critical = await computeCriticalSources(input);
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

export const cryptoMarketPulse: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  const rejected = cryptoMarketPulseValidator(input.body, input.method);
  if (rejected) return rejected;

  // Critical sources: normally pre-computed by the preflight on this
  // same request. The recompute path covers direct invocation (tests,
  // dev) — if it fails here the buyer HAS paid, so this is a
  // last-resort 503, not the primary gate.
  let critical: CriticalSources;
  if (isCriticalSources(input.preflightData)) {
    critical = input.preflightData;
  } else {
    const computed = await computeCriticalSources(input);
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

  // Enrichment sources — failures degrade, never fail the call.
  const [trending, btc, polymarket] = await Promise.all([
    fetchTrending(input),
    fetchBtc(input),
    fetchPolymarket(input),
  ]);

  return {
    status: 200,
    body: buildPulseResponse({
      critical,
      trending,
      btc,
      polymarket,
      computedAt: new Date(),
    }),
  };
};

interface BuildPulseArgs {
  critical: CriticalSources;
  trending: SourceResult<TrendingBody>;
  btc: SourceResult<BtcQuote>;
  polymarket: SourceResult<PolymarketMarket[]>;
  computedAt: Date;
}

/** Pure assembly of the three-layer response — exported for tests. */
export function buildPulseResponse(args: BuildPulseArgs): Record<string, unknown> {
  const { critical, trending, btc, polymarket, computedAt } = args;

  const sentiment = bucketSentiment(critical.fearGreed.classification);

  // Axis B per chain + the overall regime from the production chain.
  const smartMoneySignal: Record<string, unknown> = {};
  const regimeByChain = {} as Record<PulseChain, Regime>;
  for (const chain of CHAINS) {
    const sum24h = critical.netflow[chain]["24h"].eligible_sum_net_flow_usd;
    const sum7d = critical.netflow[chain]["7d"].eligible_sum_net_flow_usd;
    const { direction, pace24h, pace7d } = deriveDirection(sum24h, sum7d);
    regimeByChain[chain] = deriveRegime(sentiment, direction);
    smartMoneySignal[chain] = {
      sum_net_flow_usd_24h: sum24h,
      sum_net_flow_usd_7d: sum7d,
      pace_usd_per_hour_24h: round2(pace24h),
      pace_usd_per_hour_7d: round2(pace7d),
      direction,
      eligible_tokens_24h: critical.netflow[chain]["24h"].eligible_row_count,
      eligible_tokens_7d: critical.netflow[chain]["7d"].eligible_row_count,
      regime: regimeByChain[chain],
      coverage_level: CHAIN_COVERAGE[chain],
    };
  }
  const overallRegime = regimeByChain[PRODUCTION_CHAIN];
  const overallDirection = (
    smartMoneySignal[PRODUCTION_CHAIN] as { direction: FlowDirection }
  ).direction;

  // Distinct eligible solana tokens across both windows — the
  // coverage floor behind "high" confidence.
  const solanaEligibleTokens = new Set<string>();
  for (const window of Object.keys(WINDOW_HOURS) as PulseWindow[]) {
    for (const row of critical.netflow.solana[window].rows) {
      if (row.smart_money_score >= NETFLOW_SCORE_FLOOR) {
        solanaEligibleTokens.add(row.token_address);
      }
    }
  }

  const staleSources: string[] = [];
  const failedSources: string[] = [];
  if (!trending.ok) {
    staleSources.push("trending");
    failedSources.push("trending");
  }
  if (!btc.ok) {
    staleSources.push("btc");
    failedSources.push("btc");
  } else if (btc.data.change_24h_pct === null) {
    // Coinbase fallback delivered a price but no 24h delta — partial.
    staleSources.push("btc_24h_change");
    failedSources.push("btc_24h_change");
  }
  if (!polymarket.ok) {
    staleSources.push("polymarket");
    failedSources.push("polymarket");
  }

  const trendingChecked = trending.ok
    ? crossCheckTrending(trending.data.coins, critical.netflow)
    : [];
  const polymarketSignals = polymarket.ok
    ? filterPolymarketSignals(polymarket.data).map((m) => ({
        market_id: m.market_id ?? null,
        market_title: m.market_title ?? null,
        category: m.category ?? null,
        conviction_score: m.conviction_score ?? null,
        smart_side:
          (m.smart_yes_volume_usd ?? 0) >= (m.smart_no_volume_usd ?? 0)
            ? "yes"
            : "no",
        smart_yes_volume_usd: m.smart_yes_volume_usd ?? null,
        smart_no_volume_usd: m.smart_no_volume_usd ?? null,
      }))
    : [];

  const confidence = deriveConfidence(failedSources, solanaEligibleTokens.size);
  const summary = buildSummary({
    classification: critical.fearGreed.classification,
    currentValue: critical.fearGreed.current_value,
    sentiment,
    direction: overallDirection,
    regime: overallRegime,
    confirmedTrending: trendingChecked.filter((c) => c.confirmed).length,
    totalTrending: trendingChecked.length,
    polymarketSignals: polymarketSignals.length,
    staleSources,
  });

  // Raw layer: verbatim source material. Netflow rows are capped at
  // the top 20 by gross flow per chain+window to keep the payload
  // bounded — the sums above are computed over ALL rows first.
  const rawNetflow: Record<string, unknown> = {};
  for (const chain of CHAINS) {
    const perWindow: Record<string, unknown> = {};
    for (const window of Object.keys(WINDOW_HOURS) as PulseWindow[]) {
      const cw = critical.netflow[chain][window];
      perWindow[window] = {
        row_count: cw.rows.length,
        eligible_row_count: cw.eligible_row_count,
        eligible_sum_net_flow_usd: cw.eligible_sum_net_flow_usd,
        rows: cw.rows.slice(0, 20),
      };
    }
    rawNetflow[chain] = perWindow;
  }

  return {
    verdict: { regime: overallRegime, summary, confidence },
    signals: {
      sentiment: {
        value: critical.fearGreed.current_value,
        classification: critical.fearGreed.classification,
        bucket: sentiment,
      },
      smart_money: smartMoneySignal,
      trending: trendingChecked.map((c) => ({
        symbol: c.symbol ?? null,
        name: c.name ?? null,
        market_cap_rank: c.market_cap_rank ?? null,
        confirmed: c.confirmed,
      })),
      btc: btc.ok
        ? {
            price_usd: btc.data.price_usd,
            change_24h_pct: btc.data.change_24h_pct,
            source: btc.data.source,
          }
        : null,
      polymarket: polymarketSignals,
    },
    data_quality: {
      solana: CHAIN_COVERAGE.solana,
      base: CHAIN_COVERAGE.base,
      stale_sources: staleSources,
      computed_at: computedAt.toISOString(),
    },
    raw: {
      fear_greed: critical.fearGreed,
      trending: trending.ok ? trending.raw : null,
      smart_money_netflow: rawNetflow,
      btc: btc.ok ? btc.raw : null,
      polymarket: polymarket.ok ? polymarket.raw : null,
    },
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
