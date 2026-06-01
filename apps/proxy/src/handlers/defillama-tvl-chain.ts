/**
 * Per-chain TVL backed by DeFiLlama (`/v2/chains`). Buyer pays the
 * proxy ($0.01), then we return every blockchain DeFiLlama tracks
 * with its current TVL, the canonical chain id, and the 1d/7d
 * percentage moves.
 *
 * No input. The upstream is global and unfiltered; downstream
 * agents that only want EVM/Solana/etc. filter client-side.
 *
 * 429 → 503 `rate_limit_upstream` (DeFiLlama is generous but a
 * burst from one proxy CAN trip it, and the buyer needs a
 * retryable signal). Other non-2xx → 502.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

interface DefillamaChain {
  name?: string;
  gecko_id?: string | null;
  tvl?: number | null;
  tokenSymbol?: string | null;
  chainId?: number | null;
  cmcId?: string | null;
  change_1d?: number | null;
  change_7d?: number | null;
}

const TIMEOUT_MS = 10_000;

export const defillamaTvlChain: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  // Body is documented `{}`. Tolerate empty + tolerate any JSON
  // shape — DeFiLlama's `/v2/chains` takes no parameters.
  if (input.body && input.body.length > 0) {
    try {
      JSON.parse(input.body.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "invalid_json_body" } };
    }
  }

  const url = "https://api.llama.fi/v2/chains";
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
  if (response.status >= 500) {
    return { status: 502, body: { error: "upstream_error", upstreamStatus: response.status } };
  }
  if (!response.ok) {
    return { status: 502, body: { error: "upstream_error", upstreamStatus: response.status } };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { status: 502, body: { error: "upstream_invalid_json" } };
  }
  if (!Array.isArray(data)) {
    return { status: 502, body: { error: "upstream_unexpected_shape" } };
  }

  const chains = (data as DefillamaChain[]).map((c) => ({
    name: c.name ?? null,
    chain_id: c.chainId ?? null,
    token_symbol: c.tokenSymbol ?? null,
    tvl_usd: c.tvl ?? null,
    change_1d: c.change_1d ?? null,
    change_7d: c.change_7d ?? null,
  }));

  return {
    status: 200,
    body: { count: chains.length, chains },
  };
};
