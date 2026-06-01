/**
 * Top liquidity pools on Solana backed by GeckoTerminal
 * (`/networks/solana/pools`). Same shape and reasoning as the
 * Base sibling — only the network slug differs.
 *
 * Kept as a separate handler (rather than parameterising the
 * network on one shared file) because Solana and Base are by far
 * the two chains buyers ask for, and chain-specific endpoints
 * route+rate cleaner in CDP Bazaar than a single multi-chain
 * passthrough. If we ever add a third popular chain, then a
 * shared handler with a `chain` parameter becomes worthwhile.
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
    reserve_in_usd?: string;
    pool_created_at?: string;
    volume_usd?: { h24?: string };
    price_change_percentage?: { h24?: string };
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

export const geckoterminalSolanaPools: InternalHandler = async (
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

  const url = "https://api.geckoterminal.com/api/v2/networks/solana/pools?page=1";
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
    body: { chain: "solana", limit, count: pools.length, pools },
  };
};
