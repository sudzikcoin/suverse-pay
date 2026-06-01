/**
 * Registry stub for the SuVerse Solana Swap.
 *
 * The actual execute flow lives at `/v1/swap/solana/execute/:quoteId`
 * (see `apps/proxy/src/swap.ts`) — it can't be served through the
 * generic internal-handler pipeline because swap pricing is dynamic
 * per quote, whereas the generic pipeline derives price from
 * `seller_proxy_configs.price` (static column).
 *
 * The swap still gets a `seller_proxy_configs` row for CDP Bazaar
 * discovery + dashboard listing, with `internal_handler =
 * 'swap_solana_execute'` (the spec says so) so it lights up in
 * tooling that filters on internal_handler. If something actually
 * routes a settled payment through this handler, that's a config
 * bug — we return a clear redirect so the buyer doesn't get a silent
 * 200 + an empty body, and the operator notices in logs.
 */
import type { InternalHandler, InternalHandlerResult } from "./types.js";

export const swapSolanaExecute: InternalHandler = async (): Promise<InternalHandlerResult> => {
  return {
    status: 503,
    body: {
      error: "swap_must_use_dedicated_route",
      detail:
        "Call POST /v1/swap/solana/quote first, then POST /v1/swap/solana/execute/{quote_id}. " +
        "This endpoint is for discovery metadata only.",
    },
  };
};
