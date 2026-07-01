/**
 * Market Regime Verdict — ONE $0.50 call that answers the question a
 * portfolio agent actually asks: "is this a risk-on tape, a risk-off
 * tape, or chop?" — with driver attribution, smart-money confirmation
 * and a numeric confidence.
 *
 * Composition (extends crypto_market_pulse, which stays untouched at
 * its own $0.10 price point as the funnel):
 *
 *   BASE (critical, fail-closed) — the crypto_market_pulse handler is
 *     invoked IN-PROCESS with the same input. Our preflight delegates
 *     to `cryptoMarketPulsePreflight`, so the pulse's critical pair
 *     (fear-greed + sm_trades netflow) is proven healthy BEFORE the
 *     payment settles and threaded through as `preflightData` — the
 *     pulse consumes it and never recomputes the critical work.
 *
 *   FUNDING driver (non-critical → degrade) — `binanceFundingBatch`
 *     in-process for BTCUSDT + ETHUSDT perp funding. Positive funding
 *     = longs paying to stay long = risk-on positioning.
 *
 *   STABLECOIN driver (non-critical → degrade) — `defillamaStablecoins`
 *     in-process. DeFiLlama's /stablecoins surface exposes prevDay and
 *     prevMonth but NOT prevWeek, so a true 7d delta is NOT derivable;
 *     we honestly expose the 24h supply delta instead and score it on
 *     its own (tighter) full-scale. Growing stablecoin float = dry
 *     powder entering = risk-on.
 *
 * The verdict itself is `classifyRegime` — a pure, exported weighted
 * sum. Every driver is scored to [-1, +1], multiplied by its weight
 * (weights sum to 1.0, constants below), and summed into S:
 *
 *   S > +0.25 → risk_on     S < -0.25 → risk_off     else → chop
 *
 * Missing (stale) drivers contribute 0 — the sum is NOT renormalized,
 * so a thin read drifts toward chop by construction, and confidence
 * drops with the fraction of stale drivers and with driver dispersion
 * (strong conflicting drivers = low conviction even when S clears a
 * threshold).
 *
 * Note on fear-greed polarity: crypto_market_pulse reads fear
 * contrarian-style (fear + inflow = accumulation). HERE fear-greed is
 * a coincident risk-appetite gauge — greed scores risk-on — because
 * this endpoint describes the CURRENT tape, not the contrarian setup.
 * The pulse's contrarian regime is surfaced verbatim in
 * `signals.base_pulse.regime_from_pulse` so buyers get both readings.
 *
 * Note on polymarket: the pulse deliberately ignores bias_score
 * (bimodal at ±100) and exposes only per-market conviction signals,
 * from which no market-wide direction can be honestly derived — so
 * the handler never feeds the optional `polymarket_bias` driver.
 * `classifyRegime` still accepts it for direct callers who have a
 * trustworthy aggregate.
 */
import {
  cryptoMarketPulse,
  cryptoMarketPulsePreflight,
} from "./crypto-market-pulse.js";
import { binanceFundingBatch } from "./binance-funding-batch.js";
import { defillamaStablecoins } from "./defillama-stablecoins.js";
import { isPlaceholderValue, type InternalHandlerInputSchema } from "./discovery.js";
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerPreflight,
  InternalHandlerResult,
  InternalHandlerValidator,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────
// Weights + scales — every constant that shapes the verdict lives here.
// ─────────────────────────────────────────────────────────────────────

/** Driver weights. MUST sum to 1.0 (asserted by the table tests). */
export const REGIME_WEIGHTS = {
  /** Fear & Greed index as a coincident risk-appetite gauge. */
  fear_greed: 0.2,
  /** BTC price momentum — the market's spine. */
  btc_momentum: 0.25,
  /** Smart-money netflow direction × magnitude (production chain). */
  smart_money: 0.25,
  /** Perp funding (BTC+ETH average) — leveraged positioning. */
  funding: 0.15,
  /** Stablecoin float delta — dry powder entering/leaving. */
  stablecoins: 0.1,
  /** Optional aggregate polymarket bias — never fed by this handler. */
  polymarket: 0.05,
} as const;

export type RegimeDriverName = keyof typeof REGIME_WEIGHTS;

/** S above this → risk_on; below the negation → risk_off (strict). */
const REGIME_THRESHOLD = 0.25;
/** |driver score| below this reads as "neutral" in the attribution. */
const NEUTRAL_SCORE_BAND = 0.1;
/** ±5% BTC move in 24h = full-scale momentum signal. */
const BTC_24H_FULL_SCALE_PCT = 5;
/** ±10% BTC move in 7d = full-scale (blended 40% when available). */
const BTC_7D_FULL_SCALE_PCT = 10;
const BTC_7D_BLEND = 0.4;
/** Eligible smart-money 24h netflow (USD) at which |score| saturates. */
const SM_FULL_MAGNITUDE_USD = 5_000;
/** Direction known but magnitude unknown → half-strength signal. */
const SM_DIRECTION_ONLY_SCORE = 0.5;
/** ±0.05% per funding interval = full-scale positioning signal. */
const FUNDING_FULL_SCALE_RATE = 0.0005;
/** ±1.0% stablecoin float move over 7d = full scale. */
const STABLE_7D_FULL_SCALE_PCT = 1.0;
/** ±0.3% over 24h = full scale (the honest fallback window). */
const STABLE_24H_FULL_SCALE_PCT = 0.3;
/** |S| at which the strength leg of confidence saturates. */
const CONFIDENCE_FULL_SCORE = 0.5;
/** Raw source payload caps for the `raw` layer. */
const RAW_STABLECOINS_TOP_N = 10;

// ─────────────────────────────────────────────────────────────────────
// classifyRegime — pure, exported for table tests.
// ─────────────────────────────────────────────────────────────────────

export type Regime = "risk_on" | "risk_off" | "chop";
export type DriverDirection = "bullish" | "bearish" | "neutral";
export type SmartMoneyDirection = "inflow" | "outflow" | "neutral";

export interface RegimeDriverInputs {
  /** Fear & Greed 0-100 (null = source stale). */
  fear_greed_value: number | null;
  /** BTC 24h change in percent. */
  btc_24h_pct: number | null;
  /** BTC 7d change in percent — the pulse does not expose it; null. */
  btc_7d_pct?: number | null;
  smart_money_direction: SmartMoneyDirection | null;
  /** |eligible 24h net flow USD| on the production chain. */
  smart_money_magnitude: number | null;
  /** Last funding rate (decimal per interval, e.g. 0.0001 = 1bp). */
  funding_btc: number | null;
  funding_eth: number | null;
  /** True 7d float delta — not derivable from DeFiLlama today; null. */
  stablecoin_7d_delta_pct: number | null;
  /** Honest 24h fallback, used only when the 7d delta is null. */
  stablecoin_24h_delta_pct?: number | null;
  /** Aggregate polymarket bias [-100, +100]; omit to exclude driver. */
  polymarket_bias?: number | null;
}

export interface RegimeDriver {
  name: RegimeDriverName;
  direction: DriverDirection;
  weight: number;
  /** The raw input the score was derived from (null when stale). */
  value: number | string | null;
  evidence: string;
  /** Normalized [-1, +1] score, null when the driver is stale. */
  score: number | null;
  fresh: boolean;
}

export interface RegimeClassification {
  regime: Regime;
  /** Weighted sum S, rounded to 4dp (threshold compare is post-round). */
  score: number;
  drivers: RegimeDriver[];
  /** 0..1, 2dp — |S| strength × freshness, discounted by dispersion. */
  confidence: number;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

function directionOf(score: number | null): DriverDirection {
  if (score === null || Math.abs(score) < NEUTRAL_SCORE_BAND) return "neutral";
  return score > 0 ? "bullish" : "bearish";
}

function makeDriver(
  name: RegimeDriverName,
  score: number | null,
  value: number | string | null,
  evidence: string,
): RegimeDriver {
  const rounded = score === null ? null : round4(clamp(score, -1, 1));
  return {
    name,
    direction: directionOf(rounded),
    weight: REGIME_WEIGHTS[name],
    value,
    evidence,
    score: rounded,
    fresh: rounded !== null,
  };
}

/**
 * The brain. Scores each driver to [-1, +1], multiplies by its weight,
 * sums into S (4dp), then:
 *   S > +0.25 → risk_on | S < -0.25 → risk_off | else chop.
 * Confidence = (0.5 × min(|S|/0.5, 1) + 0.5 × fresh_fraction) ×
 * (1 − conflict), where conflict = min(pos, neg)/(pos+neg) over the
 * weighted contributions — strong drivers pulling in opposite
 * directions cut conviction even when S clears a threshold.
 */
export function classifyRegime(inputs: RegimeDriverInputs): RegimeClassification {
  const drivers: RegimeDriver[] = [];

  // Fear & Greed — 0..100 mapped linearly around the 50 midpoint.
  {
    const v = inputs.fear_greed_value;
    const score = v === null ? null : (clamp(v, 0, 100) - 50) / 50;
    drivers.push(
      makeDriver(
        "fear_greed",
        score,
        v,
        v === null
          ? "fear-greed index unavailable"
          : `fear-greed at ${v}/100 (50 = neutral risk appetite)`,
      ),
    );
  }

  // BTC momentum — 24h leg, blended 60/40 with 7d when available.
  {
    const p24 = inputs.btc_24h_pct;
    const p7 = inputs.btc_7d_pct ?? null;
    let score: number | null = null;
    if (p24 !== null) {
      score = clamp(p24 / BTC_24H_FULL_SCALE_PCT, -1, 1);
      if (p7 !== null) {
        score =
          (1 - BTC_7D_BLEND) * score +
          BTC_7D_BLEND * clamp(p7 / BTC_7D_FULL_SCALE_PCT, -1, 1);
      }
    } else if (p7 !== null) {
      score = clamp(p7 / BTC_7D_FULL_SCALE_PCT, -1, 1);
    }
    drivers.push(
      makeDriver(
        "btc_momentum",
        score,
        p24 ?? p7,
        score === null
          ? "BTC price change unavailable"
          : `BTC ${p24 !== null ? `${p24 >= 0 ? "+" : ""}${p24}% 24h` : ""}${p24 !== null && p7 !== null ? ", " : ""}${p7 !== null ? `${p7 >= 0 ? "+" : ""}${p7}% 7d` : ""}`,
      ),
    );
  }

  // Smart money — direction sign × magnitude saturation.
  {
    const dir = inputs.smart_money_direction;
    const mag = inputs.smart_money_magnitude;
    let score: number | null = null;
    if (dir === "neutral") score = 0;
    else if (dir === "inflow" || dir === "outflow") {
      const sign = dir === "inflow" ? 1 : -1;
      score =
        sign *
        (mag === null
          ? SM_DIRECTION_ONLY_SCORE
          : clamp(Math.abs(mag) / SM_FULL_MAGNITUDE_USD, 0, 1));
    }
    drivers.push(
      makeDriver(
        "smart_money",
        score,
        dir,
        dir === null
          ? "smart-money netflow unavailable"
          : `tracked smart wallets show ${dir}${mag !== null ? ` ($${Math.abs(mag)} eligible 24h netflow)` : ""}`,
      ),
    );
  }

  // Funding — average of whichever legs are present.
  {
    const legs = [inputs.funding_btc, inputs.funding_eth].filter(
      (x): x is number => x !== null,
    );
    const avg = legs.length > 0 ? legs.reduce((a, b) => a + b, 0) / legs.length : null;
    const score = avg === null ? null : clamp(avg / FUNDING_FULL_SCALE_RATE, -1, 1);
    drivers.push(
      makeDriver(
        "funding",
        score,
        avg,
        avg === null
          ? "perp funding unavailable"
          : `avg BTC/ETH perp funding ${(avg * 100).toFixed(4)}% per interval (${avg >= 0 ? "longs" : "shorts"} paying)`,
      ),
    );
  }

  // Stablecoins — 7d delta when derivable, else the honest 24h window.
  {
    const d7 = inputs.stablecoin_7d_delta_pct;
    const d24 = inputs.stablecoin_24h_delta_pct ?? null;
    let score: number | null = null;
    let value: number | null = null;
    let windowLabel = "";
    if (d7 !== null) {
      score = clamp(d7 / STABLE_7D_FULL_SCALE_PCT, -1, 1);
      value = d7;
      windowLabel = "7d";
    } else if (d24 !== null) {
      score = clamp(d24 / STABLE_24H_FULL_SCALE_PCT, -1, 1);
      value = d24;
      windowLabel = "24h";
    }
    drivers.push(
      makeDriver(
        "stablecoins",
        score,
        value,
        score === null
          ? "stablecoin float delta unavailable"
          : `stablecoin float ${value !== null && value >= 0 ? "grew" : "shrank"} ${Math.abs(value ?? 0).toFixed(3)}% over ${windowLabel}`,
      ),
    );
  }

  // Polymarket — optional; only participates when the caller passes it.
  if (inputs.polymarket_bias !== undefined) {
    const b = inputs.polymarket_bias;
    const score = b === null ? null : clamp(b / 100, -1, 1);
    drivers.push(
      makeDriver(
        "polymarket",
        score,
        b,
        b === null
          ? "polymarket bias unavailable"
          : `aggregate polymarket smart bias ${b}`,
      ),
    );
  }

  // Weighted sum + dispersion over the fresh contributions.
  let pos = 0;
  let neg = 0;
  for (const d of drivers) {
    if (d.score === null) continue;
    const contribution = d.score * d.weight;
    if (contribution >= 0) pos += contribution;
    else neg += -contribution;
  }
  const score = round4(pos - neg);
  const regime: Regime =
    score > REGIME_THRESHOLD
      ? "risk_on"
      : score < -REGIME_THRESHOLD
        ? "risk_off"
        : "chop";

  const freshCount = drivers.filter((d) => d.fresh).length;
  const freshFraction = drivers.length > 0 ? freshCount / drivers.length : 0;
  const strength = clamp(Math.abs(score) / CONFIDENCE_FULL_SCORE, 0, 1);
  const conflict = pos + neg > 0 ? Math.min(pos, neg) / (pos + neg) : 0;
  const confidence = round2(
    clamp((0.5 * strength + 0.5 * freshFraction) * (1 - conflict), 0, 1),
  );

  return { regime, score, drivers, confidence };
}

// ─────────────────────────────────────────────────────────────────────
// Input contract — all optional; empty / non-JSON body = the product.
// ─────────────────────────────────────────────────────────────────────

export type DetailLevel = "summary" | "full";
const DETAIL_LEVELS: readonly DetailLevel[] = ["summary", "full"];

export const marketRegimeVerdictInputSchema: InternalHandlerInputSchema = {
  method: "POST",
  content_type: "application/json",
  body: {
    type: "object",
    required: [],
    properties: {
      detail: {
        type: "string",
        description:
          'Response detail level (default "full"). "summary" omits the raw base-pulse payload from the raw layer.',
        pattern: "^(summary|full)$",
      },
    },
  },
  example: { detail: "full" },
};

type ParsedBody =
  | { kind: "ok"; detail: DetailLevel }
  | { kind: "invalid"; error: string; detail: string };

/**
 * Empty / missing / unparseable / JSON-null bodies all mean "defaults"
 * — a schema-blind discovery probe must reach the 402 challenge, and a
 * paid caller with no opinions gets the full product. Only a body that
 * is REAL JSON of the wrong shape, or a real-but-wrong `detail` value,
 * is rejected (422 + machine-readable input_schema).
 */
function parseRegimeBody(body: Buffer | null): ParsedBody {
  if (!body || body.length === 0) return { kind: "ok", detail: "full" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { kind: "ok", detail: "full" };
  }
  if (parsed === null) return { kind: "ok", detail: "full" };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      kind: "invalid",
      error: "invalid_body",
      detail: "body must be empty or a JSON object",
    };
  }
  const rawDetail = (parsed as Record<string, unknown>)["detail"];
  if (rawDetail === undefined || rawDetail === null) {
    return { kind: "ok", detail: "full" };
  }
  if (typeof rawDetail !== "string") {
    return {
      kind: "invalid",
      error: "invalid_detail",
      detail: `detail must be one of ${DETAIL_LEVELS.join("|")}`,
    };
  }
  if (isPlaceholderValue(rawDetail)) return { kind: "ok", detail: "full" };
  const d = rawDetail.trim().toLowerCase();
  if (!(DETAIL_LEVELS as readonly string[]).includes(d)) {
    return {
      kind: "invalid",
      error: "invalid_detail",
      detail: `detail must be one of ${DETAIL_LEVELS.join("|")}`,
    };
  }
  return { kind: "ok", detail: d as DetailLevel };
}

export const marketRegimeVerdictValidator: InternalHandlerValidator = (
  body,
  _method,
) => {
  const parsed = parseRegimeBody(body);
  if (parsed.kind === "ok") return null;
  return {
    status: 422,
    body: {
      error: parsed.error,
      detail: parsed.detail,
      input_schema: marketRegimeVerdictInputSchema,
    },
  };
};

// ─────────────────────────────────────────────────────────────────────
// Preflight — pure delegation to the base pulse's fail-closed gate.
// ─────────────────────────────────────────────────────────────────────

/**
 * The verdict is impossible without the pulse's critical pair
 * (fear-greed + sm_trades netflow), and the pulse already knows how to
 * prove them, so we delegate wholesale. Its result passes through
 * unchanged: `proceed: true` carries the pulse's critical-sources
 * bundle, which the dispatcher threads to our handler as
 * `preflightData` and our handler forwards verbatim to the in-process
 * pulse call — the shape check inside the pulse recognizes it and
 * skips the recompute. A throw here is the dispatcher's 503 no-charge.
 */
export const marketRegimeVerdictPreflight: InternalHandlerPreflight = (input) =>
  cryptoMarketPulsePreflight(input);

// ─────────────────────────────────────────────────────────────────────
// Driver layers — funding + stablecoins (non-critical, degrade).
// ─────────────────────────────────────────────────────────────────────

export interface FundingLayer {
  ok: boolean;
  error: string | null;
  funding_btc: number | null;
  funding_eth: number | null;
  raw: unknown;
}

async function fetchFundingLayer(
  input: InternalHandlerInput,
): Promise<FundingLayer> {
  const failed = (error: string): FundingLayer => ({
    ok: false,
    error,
    funding_btc: null,
    funding_eth: null,
    raw: null,
  });
  try {
    const res = await binanceFundingBatch({
      body: Buffer.from(JSON.stringify({ symbols: ["BTCUSDT", "ETHUSDT"] })),
      method: "POST",
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    if (res.status !== 200) return failed(`funding_status_${res.status}`);
    const rates = (res.body as { rates?: Array<Record<string, unknown>> }).rates;
    if (!Array.isArray(rates)) return failed("funding_bad_shape");
    const rateFor = (symbol: string): number | null => {
      const row = rates.find((r) => r["symbol"] === symbol);
      const v = row?.["funding_rate"];
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    };
    return {
      ok: true,
      error: null,
      funding_btc: rateFor("BTCUSDT"),
      funding_eth: rateFor("ETHUSDT"),
      raw: res.body,
    };
  } catch {
    return failed("funding_unreachable");
  }
}

export interface StableLayer {
  ok: boolean;
  error: string | null;
  total_supply_usd: number | null;
  delta_24h_usd: number | null;
  delta_24h_pct: number | null;
  /** Not derivable from DeFiLlama's prevDay/prevMonth surface. */
  delta_7d_pct: null;
  raw: unknown;
}

async function fetchStableLayer(
  input: InternalHandlerInput,
): Promise<StableLayer> {
  const failed = (error: string): StableLayer => ({
    ok: false,
    error,
    total_supply_usd: null,
    delta_24h_usd: null,
    delta_24h_pct: null,
    delta_7d_pct: null,
    raw: null,
  });
  try {
    const res = await defillamaStablecoins({
      body: null,
      method: "POST",
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    if (res.status !== 200) return failed(`stablecoins_status_${res.status}`);
    const body = res.body as {
      top_n_total_supply_usd?: number;
      stablecoins?: Array<{
        circulating_usd?: number | null;
        change_24h_usd?: number | null;
      }>;
    };
    const total =
      typeof body.top_n_total_supply_usd === "number"
        ? body.top_n_total_supply_usd
        : null;
    const coins = Array.isArray(body.stablecoins) ? body.stablecoins : [];
    let delta = 0;
    let deltaSeen = false;
    for (const c of coins) {
      if (typeof c.change_24h_usd === "number") {
        delta += c.change_24h_usd;
        deltaSeen = true;
      }
    }
    const prevTotal =
      total !== null && deltaSeen ? total - delta : null;
    const deltaPct =
      prevTotal !== null && prevTotal > 0 ? (delta / prevTotal) * 100 : null;
    // Cap the raw layer: the sums above run over the full top-20 list.
    const raw = {
      top_n_total_supply_usd: total,
      stablecoins: coins.slice(0, RAW_STABLECOINS_TOP_N),
    };
    return {
      ok: true,
      error: null,
      total_supply_usd: total,
      delta_24h_usd: deltaSeen ? round2(delta) : null,
      delta_24h_pct: deltaPct === null ? null : round4(deltaPct),
      delta_7d_pct: null,
      raw,
    };
  } catch {
    return failed("stablecoins_unreachable");
  }
}

// ─────────────────────────────────────────────────────────────────────
// Base-pulse extraction — defensive structural reads only.
// ─────────────────────────────────────────────────────────────────────

interface PulseView {
  regime: string | null;
  sentimentValue: number | null;
  sentimentClassification: string | null;
  btcPriceUsd: number | null;
  btc24hPct: number | null;
  smDirection: SmartMoneyDirection | null;
  smNetFlow24hUsd: number | null;
  staleSources: string[];
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function viewPulse(body: unknown): PulseView {
  const b = (body ?? {}) as Record<string, unknown>;
  const verdict = (b["verdict"] ?? {}) as Record<string, unknown>;
  const signals = (b["signals"] ?? {}) as Record<string, unknown>;
  const sentiment = (signals["sentiment"] ?? {}) as Record<string, unknown>;
  const btc = (signals["btc"] ?? null) as Record<string, unknown> | null;
  const smartMoney = (signals["smart_money"] ?? {}) as Record<string, unknown>;
  // The pulse's OVERALL regime comes from its production chain (solana).
  const solana = (smartMoney["solana"] ?? {}) as Record<string, unknown>;
  const dq = (b["data_quality"] ?? {}) as Record<string, unknown>;
  const rawDir = solana["direction"];
  const smDirection =
    rawDir === "inflow" || rawDir === "outflow" || rawDir === "neutral"
      ? rawDir
      : null;
  const stale = dq["stale_sources"];
  return {
    regime: typeof verdict["regime"] === "string" ? verdict["regime"] : null,
    sentimentValue: asNumber(sentiment["value"]),
    sentimentClassification:
      typeof sentiment["classification"] === "string"
        ? sentiment["classification"]
        : null,
    btcPriceUsd: btc ? asNumber(btc["price_usd"]) : null,
    btc24hPct: btc ? asNumber(btc["change_24h_pct"]) : null,
    smDirection,
    smNetFlow24hUsd: asNumber(solana["sum_net_flow_usd_24h"]),
    staleSources: Array.isArray(stale)
      ? stale.filter((s): s is string => typeof s === "string")
      : [],
  };
}

// ─────────────────────────────────────────────────────────────────────
// Response assembly — pure, exported for tests.
// ─────────────────────────────────────────────────────────────────────

export interface BuildRegimeArgs {
  pulseBody: unknown;
  funding: FundingLayer;
  stable: StableLayer;
  detail: DetailLevel;
  computedAt: Date;
}

/** One sentence naming the strongest drivers behind the call. */
function regimeSummary(c: RegimeClassification): string {
  const ranked = c.drivers
    .filter((d) => d.fresh && d.score !== null)
    .sort(
      (a, b) =>
        Math.abs((b.score ?? 0) * b.weight) - Math.abs((a.score ?? 0) * a.weight),
    )
    .slice(0, 2);
  const named =
    ranked.length > 0
      ? ranked.map((d) => `${d.name} (${d.direction})`).join(" and ")
      : "no fresh drivers";
  const label =
    c.regime === "risk_on"
      ? "Risk-on"
      : c.regime === "risk_off"
        ? "Risk-off"
        : "Choppy";
  return `${label} tape (score ${c.score >= 0 ? "+" : ""}${c.score}), led by ${named}.`;
}

/** Four-layer assembly: verdict / signals / data_quality / raw. */
export function buildRegimeResponse(args: BuildRegimeArgs): Record<string, unknown> {
  const { pulseBody, funding, stable, detail, computedAt } = args;
  const pulse = viewPulse(pulseBody);

  const classification = classifyRegime({
    fear_greed_value: pulse.sentimentValue,
    btc_24h_pct: pulse.btc24hPct,
    btc_7d_pct: null, // the pulse does not expose a 7d BTC delta
    smart_money_direction: pulse.smDirection,
    smart_money_magnitude:
      pulse.smNetFlow24hUsd === null ? null : Math.abs(pulse.smNetFlow24hUsd),
    funding_btc: funding.funding_btc,
    funding_eth: funding.funding_eth,
    stablecoin_7d_delta_pct: stable.delta_7d_pct,
    stablecoin_24h_delta_pct: stable.delta_24h_pct,
    // polymarket_bias deliberately omitted — see header note.
  });

  // Stale sources: the pulse's own list ∪ our two driver layers.
  const staleSources = [...pulse.staleSources];
  const fundingDriver = classification.drivers.find((d) => d.name === "funding");
  const stableDriver = classification.drivers.find(
    (d) => d.name === "stablecoins",
  );
  if (fundingDriver && !fundingDriver.fresh) staleSources.push("funding");
  if (stableDriver && !stableDriver.fresh) staleSources.push("stablecoins");

  const smAgrees =
    (pulse.smDirection === "inflow" && classification.regime === "risk_on") ||
    (pulse.smDirection === "outflow" && classification.regime === "risk_off") ||
    (pulse.smDirection === "neutral" && classification.regime === "chop");

  const raw: Record<string, unknown> = {
    ...(detail === "full" ? { pulse: pulseBody } : {}),
    funding: funding.ok ? funding.raw : null,
    stablecoins: stable.ok ? stable.raw : null,
  };

  return {
    verdict: {
      regime: classification.regime,
      score: classification.score,
      summary: regimeSummary(classification),
      confidence: classification.confidence,
    },
    signals: {
      drivers: classification.drivers,
      smart_money_confirmation: {
        direction: pulse.smDirection,
        agrees_with_regime: smAgrees,
      },
      base_pulse: {
        regime_from_pulse: pulse.regime,
        sentiment: {
          value: pulse.sentimentValue,
          classification: pulse.sentimentClassification,
        },
        btc: {
          price_usd: pulse.btcPriceUsd,
          change_24h_pct: pulse.btc24hPct,
        },
      },
    },
    data_quality: {
      stale_sources: staleSources,
      computed_at: computedAt.toISOString(),
      drivers_fresh_count: classification.drivers.filter((d) => d.fresh).length,
    },
    raw,
  };
}

// ─────────────────────────────────────────────────────────────────────
// The handler
// ─────────────────────────────────────────────────────────────────────

export const marketRegimeVerdict: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  const rejected = marketRegimeVerdictValidator(input.body, input.method);
  if (rejected) return rejected;
  const parsed = parseRegimeBody(input.body);
  const detail = parsed.kind === "ok" ? parsed.detail : "full";

  // Forward the buyer's body to the pulse only when it is a shape the
  // pulse's own validator accepts (a JSON object); our lenient inputs
  // (non-JSON garbage) collapse to null so the base never 400s on them.
  let forwardBody: Buffer | null = null;
  if (input.body && input.body.length > 0) {
    try {
      const p: unknown = JSON.parse(input.body.toString("utf8"));
      if (p !== null && typeof p === "object" && !Array.isArray(p)) {
        forwardBody = input.body;
      }
    } catch {
      forwardBody = null;
    }
  }

  // Base pulse (critical) + the two driver layers, all in parallel.
  // `preflightData` — our preflight IS the pulse's preflight — passes
  // through verbatim so the pulse skips its critical recompute.
  const [pulseRes, funding, stable] = await Promise.all([
    cryptoMarketPulse({
      body: forwardBody,
      method: "POST",
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.db ? { db: input.db } : {}),
      ...(input.preflightData !== undefined
        ? { preflightData: input.preflightData }
        : {}),
    }),
    fetchFundingLayer(input),
    fetchStableLayer(input),
  ]);

  if (pulseRes.status !== 200) {
    // The base layer is critical. Normally the preflight has already
    // refused pre-settlement; this path covers direct invocation.
    return {
      status: 503,
      body: {
        error: "critical_source_unavailable",
        source: "crypto_market_pulse",
        detail: pulseRes.body,
        retryable: true,
      },
    };
  }

  return {
    status: 200,
    body: buildRegimeResponse({
      pulseBody: pulseRes.body,
      funding,
      stable,
      detail,
      computedAt: new Date(),
    }),
  };
};
