/**
 * Precious metals spot prices (gold/silver/platinum/palladium)
 * backed by Stooq's free CSV quote endpoint. Buyer pays the proxy
 * ($0.005), then we fetch the four XAU/XAG/XPT/XPD pairs in one
 * call (Stooq's `+`-separated multi-symbol syntax) and parse the
 * CSV into a typed JSON envelope.
 *
 * Stooq quotes are spot per troy ounce in USD — the institutional
 * convention. `N/D` rows from upstream become `null` fields here
 * so callers don't have to parse "N/D" specially.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

const TIMEOUT_MS = 10_000;
const SYMBOLS = ["xauusd", "xagusd", "xptusd", "xpdusd"] as const;
const LABELS: Record<string, string> = {
  XAUUSD: "gold",
  XAGUSD: "silver",
  XPTUSD: "platinum",
  XPDUSD: "palladium",
};

interface Quote {
  symbol: string;
  metal: string;
  date: string | null;
  time: string | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  name: string | null;
}

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
    metal: LABELS[sym] ?? sym.toLowerCase(),
    date: str("date"),
    time: str("time"),
    open: num("open"),
    high: num("high"),
    low: num("low"),
    close: num("close"),
    name: str("name"),
  };
}

export const stooqPreciousMetals: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  if (input.body && input.body.length > 0) {
    try {
      JSON.parse(input.body.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "invalid_json_body" } };
    }
  }

  const url = `https://stooq.com/q/l/?s=${SYMBOLS.join("+")}&f=sd2t2ohlcvn&h&e=csv`;
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

  return {
    status: 200,
    body: {
      count: quotes.length,
      currency: "USD",
      unit: "troy_ounce",
      metals: quotes,
    },
  };
};
