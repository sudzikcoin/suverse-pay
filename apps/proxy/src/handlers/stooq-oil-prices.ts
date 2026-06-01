/**
 * Crude oil spot prices (WTI + Brent) backed by Stooq CSV.
 * Buyer pays the proxy ($0.005), then we fetch both contracts
 * in one upstream call:
 *   - CL.F → WTI front-month crude (NYMEX)
 *   - CB.F → Brent front-month crude (ICE)
 *
 * Both are reported as spot $ per barrel. We surface the two
 * quotes side-by-side and compute the WTI/Brent spread — the
 * conventional metric a macro agent reads first.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

const TIMEOUT_MS = 10_000;

interface Quote {
  symbol: string;
  benchmark: "wti" | "brent" | "unknown";
  date: string | null;
  time: string | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  name: string | null;
}

const BENCHMARK_OF: Record<string, "wti" | "brent"> = {
  "CL.F": "wti",
  "CB.F": "brent",
};

function parseRow(headers: string[], row: string[]): Quote | null {
  const map = new Map<string, string>();
  for (let i = 0; i < headers.length; i++) {
    map.set(headers[i]!.toLowerCase(), row[i] ?? "");
  }
  const sym = (map.get("symbol") ?? "").toUpperCase();
  if (!sym) return null;
  const num = (key: string): number | null => {
    const v = map.get(key);
    if (!v || v === "N/D") return null;
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const str = (key: string): string | null => {
    const v = map.get(key);
    return v && v !== "N/D" ? v : null;
  };
  return {
    symbol: sym,
    benchmark: BENCHMARK_OF[sym] ?? "unknown",
    date: str("date"),
    time: str("time"),
    open: num("open"),
    high: num("high"),
    low: num("low"),
    close: num("close"),
    name: str("name"),
  };
}

export const stooqOilPrices: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  if (input.body && input.body.length > 0) {
    try {
      JSON.parse(input.body.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "invalid_json_body" } };
    }
  }

  const url = "https://stooq.com/q/l/?s=cl.f+cb.f&f=sd2t2ohlcvn&h&e=csv";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { accept: "text/csv" },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") {
      return { status: 504, body: { error: "upstream_timeout" } };
    }
    return { status: 502, body: { error: "upstream_unreachable" } };
  }
  clearTimeout(timer);

  if (response.status === 429) {
    return { status: 503, body: { error: "rate_limit_upstream" } };
  }
  if (!response.ok) {
    return { status: 502, body: { error: "upstream_error", upstreamStatus: response.status } };
  }

  let csv: string;
  try {
    csv = await response.text();
  } catch {
    return { status: 502, body: { error: "upstream_read_failed" } };
  }
  const lines = csv.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) {
    return { status: 502, body: { error: "empty_csv_response" } };
  }
  const headers = lines[0]!.split(",");
  const quotes: Quote[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i]!.split(",");
    const q = parseRow(headers, row);
    if (q) quotes.push(q);
  }
  const wti = quotes.find((q) => q.benchmark === "wti");
  const brent = quotes.find((q) => q.benchmark === "brent");
  const spread =
    wti?.close !== null && wti?.close !== undefined &&
    brent?.close !== null && brent?.close !== undefined
      ? brent.close - wti.close
      : null;

  return {
    status: 200,
    body: {
      currency: "USD",
      unit: "barrel",
      wti,
      brent,
      brent_wti_spread: spread,
      count: quotes.length,
    },
  };
};
