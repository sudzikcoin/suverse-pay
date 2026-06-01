/**
 * Top liquidity pools on Base backed by GeckoTerminal
 * (`/networks/base/pools`). Buyer pays the proxy ($0.01), then
 * we return the upstream-sorted top pools (reserve_in_usd desc by
 * default) and trim each row to the columns a routing/MEV agent
 * uses: pair name, DEX, TVL, 24h volume, fee tier, price USD.
 *
 * Limit is capped at 20 — that's GeckoTerminal's per-page max on
 * `/pools`. Callers wanting deeper rankings can paginate later.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

interface GtPool {
  id?: string;
  attributes?: {
    name?: string;
    base_token_price_usd?: string;
    quote_token_price_usd?: string;
    fdv_usd?: string;
    reserve_in_usd?: string;
    pool_created_at?: string;
    volume_usd?: { h24?: string };
    price_change_percentage?: { h24?: string };
    transactions?: {
      h24?: { buys?: number; sells?: number; buyers?: number; sellers?: number };
    };
    address?: string;
  };
  relationships?: {
    dex?: { data?: { id?: string } };
    base_token?: { data?: { id?: string } };
    quote_token?: { data?: { id?: string } };
  };
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 20;
const TIMEOUT_MS = 10_000;

export const geckoterminalBasePools: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  let parsed: unknown = null;
  if (input.body && input.body.length > 0) {
    try {
      parsed = JSON.parse(input.body.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "invalid_json_body" } };
    }
  }

  let limit = DEFAULT_LIMIT;
  if (parsed !== null && typeof parsed === "object") {
    const rawLimit = (parsed as Record<string, unknown>)["limit"];
    if (rawLimit !== undefined) {
      if (
        typeof rawLimit !== "number" ||
        !Number.isInteger(rawLimit) ||
        rawLimit < 1
      ) {
        return { status: 400, body: { error: "invalid_limit" } };
      }
      limit = Math.min(rawLimit, MAX_LIMIT);
    }
  }

  const url = "https://api.geckoterminal.com/api/v2/networks/base/pools?page=1";
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

  let json: { data?: GtPool[] };
  try {
    json = (await response.json()) as { data?: GtPool[] };
  } catch {
    return { status: 502, body: { error: "upstream_invalid_json" } };
  }
  const raw = Array.isArray(json.data) ? json.data : [];

  const pools = raw.slice(0, limit).map((p) => {
    const a = p.attributes ?? {};
    return {
      id: p.id ?? null,
      address: a.address ?? null,
      name: a.name ?? null,
      dex: p.relationships?.dex?.data?.id ?? null,
      base_token: p.relationships?.base_token?.data?.id ?? null,
      quote_token: p.relationships?.quote_token?.data?.id ?? null,
      reserve_usd: a.reserve_in_usd ?? null,
      volume_24h_usd: a.volume_usd?.h24 ?? null,
      price_change_24h_pct: a.price_change_percentage?.h24 ?? null,
      base_token_price_usd: a.base_token_price_usd ?? null,
      pool_created_at: a.pool_created_at ?? null,
    };
  });

  return {
    status: 200,
    body: { chain: "base", limit, count: pools.length, pools },
  };
};
