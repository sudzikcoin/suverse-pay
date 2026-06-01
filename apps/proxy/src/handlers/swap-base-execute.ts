/**
 * Registry stub for the SuVerse Base Swap.
 *
 * The actual execute flow lives at `/v1/swap/base/execute/:quoteId`
 * (see `apps/proxy/src/swap-base.ts`) — it can't be served through
 * the generic internal-handler pipeline because swap pricing is
 * dynamic per quote, whereas the generic pipeline derives price from
 * `seller_proxy_configs.price_atomic` (static column).
 *
 * The swap still gets a `seller_proxy_configs` row for CDP Bazaar
 * discovery + dashboard listing, with `internal_handler =
 * 'swap_base_execute'`. If something actually routes a settled
 * payment through this handler (a config bug), we return a clear
 * 503 so the buyer doesn't get a silent 200 + empty body and the
 * operator notices in logs.
 *
 * Mirrors `swap-solana-execute.ts` exactly.
 */
import type { InternalHandler, InternalHandlerResult } from "./types.js";

export const swapBaseExecute: InternalHandler = async (): Promise<InternalHandlerResult> => {
  return {
    status: 503,
    body: {
      error: "swap_must_use_dedicated_route",
      detail:
        "Call POST /v1/swap/base/quote first, then POST /v1/swap/base/execute/{quote_id}. " +
        "This endpoint is for discovery metadata only.",
    },
  };
};
