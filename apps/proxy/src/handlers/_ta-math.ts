/**
 * Pure-JS technical-analysis math used by the RSI / MACD / MA
 * handlers. Kept in a leading-underscore file so the handler
 * registry's auto-import patterns (when we add them) don't mistake
 * this for a routable handler — it's a private helper module.
 *
 * Definitions match what every charting library (TradingView,
 * Binance UI, ccxt) implements:
 *   - SMA: arithmetic mean over the last N closes.
 *   - EMA: classic exponential with α = 2/(N+1), seeded with the
 *     SMA of the first N points.
 *   - RSI: Wilder's smoothing (α = 1/N), seeded with the simple
 *     average of the first N gains/losses. This is the "Wilder
 *     RSI" — the one displayed by Binance, NOT the EMA variant.
 *   - MACD: EMA12 − EMA26 with a 9-period EMA signal line.
 */

export function sma(values: number[], period: number): number[] {
  if (period <= 0) throw new Error("period must be > 0");
  const out: number[] = [];
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i]!;
  out.push(sum / period);
  for (let i = period; i < values.length; i++) {
    sum += values[i]! - values[i - period]!;
    out.push(sum / period);
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  if (period <= 0) throw new Error("period must be > 0");
  const out: number[] = [];
  if (values.length < period) return out;
  const alpha = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  seed /= period;
  out.push(seed);
  let prev = seed;
  for (let i = period; i < values.length; i++) {
    const next = (values[i]! - prev) * alpha + prev;
    out.push(next);
    prev = next;
  }
  return out;
}

export interface RsiSeries {
  rsi: number[];
  // Index inside `values` where rsi[0] aligns — equal to `period`.
  startIndex: number;
}

export function rsi(values: number[], period: number): RsiSeries {
  if (period <= 0) throw new Error("period must be > 0");
  if (values.length <= period) return { rsi: [], startIndex: period };
  // Seed: simple averages of the first `period` gains and losses.
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i]! - values[i - 1]!;
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const out: number[] = [];
  out.push(computeRsiFrom(avgGain, avgLoss));
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i]! - values[i - 1]!;
    const up = diff > 0 ? diff : 0;
    const dn = diff < 0 ? -diff : 0;
    // Wilder smoothing: α = 1/N, i.e. avg = (avg*(N-1) + new) / N.
    avgGain = (avgGain * (period - 1) + up) / period;
    avgLoss = (avgLoss * (period - 1) + dn) / period;
    out.push(computeRsiFrom(avgGain, avgLoss));
  }
  return { rsi: out, startIndex: period };
}

function computeRsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdSeries {
  macd: number[];
  signal: number[];
  histogram: number[];
  // The index in `values` where macd[0] aligns (slow EMA seed end).
  startIndex: number;
}

export function macd(
  values: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdSeries {
  if (values.length < slow + signalPeriod) {
    return { macd: [], signal: [], histogram: [], startIndex: slow - 1 };
  }
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  // Align: emaFast starts at index (fast-1), emaSlow at (slow-1).
  // We anchor on emaSlow's start.
  const offset = slow - fast;
  const macdLine: number[] = [];
  for (let i = 0; i < emaSlow.length; i++) {
    macdLine.push(emaFast[i + offset]! - emaSlow[i]!);
  }
  const signalLine = ema(macdLine, signalPeriod);
  const histogram: number[] = [];
  const sigOffset = macdLine.length - signalLine.length;
  for (let i = 0; i < signalLine.length; i++) {
    histogram.push(macdLine[i + sigOffset]! - signalLine[i]!);
  }
  return {
    macd: macdLine,
    signal: signalLine,
    histogram,
    startIndex: slow - 1,
  };
}

/**
 * Detect bullish (positive cross) and bearish (negative cross)
 * crossover events between two parallel series within the last
 * `lookback` periods. Returns the index of the most recent cross
 * (relative to the end of the arrays) and its direction, or null
 * if no cross was found in window.
 */
export function detectCross(
  a: number[],
  b: number[],
  lookback: number,
): { direction: "bullish" | "bearish"; periodsAgo: number } | null {
  const n = Math.min(a.length, b.length);
  const start = Math.max(1, n - lookback);
  for (let i = n - 1; i >= start; i--) {
    const prevAbove = a[i - 1]! > b[i - 1]!;
    const nowAbove = a[i]! > b[i]!;
    if (prevAbove !== nowAbove) {
      return {
        direction: nowAbove ? "bullish" : "bearish",
        periodsAgo: n - 1 - i,
      };
    }
  }
  return null;
}
