/**
 * Protocol fees + revenue backed by DeFiLlama
 * (`/overview/fees`). Buyer pays the proxy ($0.02), then we return
 * each protocol's 24h / 7d / 30d fee totals plus the categorized
 * `revenue` accrual splits DeFiLlama tracks.
 *
 * Upstream returns a top-level `protocols` array — we surface
 * just the columns a DeFi valuation agent reads: name, category,
 * fees over multiple windows, change percentages. The aggregate
 * `total24h`/`total7d` numbers on the parent envelope are kept
 * as `market_totals` so a portfolio agent can compute share.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

interface FeeProtocol {
  name?: string;
  category?: string | null;
  total24h?: number | null;
  total7d?: number | null;
  total30d?: number | null;
  totalAllTime?: number | null;
  change_1d?: number | null;
  change_7d?: number | null;
  change_1m?: number | null;
  chains?: string[];
  logo?: string;
}

interface FeesResponse {
  total24h?: number | null;
  total7d?: number | null;
  total30d?: number | null;
  protocols?: FeeProtocol[];
}

const TIMEOUT_MS = 10_000;

export const defillamaFees: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  if (input.body && input.body.length > 0) {
    try {
      JSON.parse(input.body.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "invalid_json_body" } };
    }
  }

  const url = "https://api.llama.fi/overview/fees";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { accept: "application/json" },
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

  let data: FeesResponse;
  try {
    data = (await response.json()) as FeesResponse;
  } catch {
    return { status: 502, body: { error: "upstream_invalid_json" } };
  }

  const protocols = Array.isArray(data.protocols)
    ? data.protocols.map((p) => ({
        name: p.name ?? null,
        category: p.category ?? null,
        chains: Array.isArray(p.chains) ? p.chains : [],
        fees_24h: p.total24h ?? null,
        fees_7d: p.total7d ?? null,
        fees_30d: p.total30d ?? null,
        fees_all_time: p.totalAllTime ?? null,
        change_1d: p.change_1d ?? null,
        change_7d: p.change_7d ?? null,
        change_1m: p.change_1m ?? null,
      }))
    : [];

  return {
    status: 200,
    body: {
      market_totals: {
        total_24h: data.total24h ?? null,
        total_7d: data.total7d ?? null,
        total_30d: data.total30d ?? null,
      },
      count: protocols.length,
      protocols,
    },
  };
};
