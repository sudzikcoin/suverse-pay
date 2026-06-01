/**
 * Cross-chain bridge 24h volumes backed by DeFiLlama Bridges
 * (`https://bridges.llama.fi/bridges`). Buyer pays the proxy
 * ($0.02), then we return per-bridge daily volume + tx-count +
 * the chains the bridge serves.
 *
 * Upstream wraps the array in `{bridges: [...]}` for some shapes
 * and returns a bare array for others — we accept both and
 * normalize to a flat array so callers don't have to branch.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

interface Bridge {
  name?: string;
  displayName?: string;
  volumePrevDay?: number;
  volumePrev2Day?: number;
  txsPrevDay?: number;
  chains?: string[];
  icon?: string;
  destinationChain?: string;
}

const TIMEOUT_MS = 10_000;

export const defillamaBridges: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  if (input.body && input.body.length > 0) {
    try {
      JSON.parse(input.body.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "invalid_json_body" } };
    }
  }

  const url = "https://bridges.llama.fi/bridges";
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

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { status: 502, body: { error: "upstream_invalid_json" } };
  }

  let rawBridges: Bridge[];
  if (Array.isArray(json)) {
    rawBridges = json as Bridge[];
  } else if (
    json !== null &&
    typeof json === "object" &&
    Array.isArray((json as Record<string, unknown>)["bridges"])
  ) {
    rawBridges = (json as { bridges: Bridge[] }).bridges;
  } else {
    return { status: 502, body: { error: "upstream_unexpected_shape" } };
  }

  const bridges = rawBridges.map((b) => ({
    name: b.name ?? null,
    display_name: b.displayName ?? b.name ?? null,
    volume_prev_day_usd: b.volumePrevDay ?? null,
    volume_prev_2day_usd: b.volumePrev2Day ?? null,
    txs_prev_day: b.txsPrevDay ?? null,
    chains: Array.isArray(b.chains) ? b.chains : [],
  }));

  return {
    status: 200,
    body: { count: bridges.length, bridges },
  };
};
