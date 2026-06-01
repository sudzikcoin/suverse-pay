/**
 * Name → handler registry consulted when a `seller_proxy_configs` row
 * has `internal_handler` set. Single source of truth for legal handler
 * names; anything else surfaces as 503 + a log line, so a typo in the
 * DB column cannot silently fall through to the upstream HTTP path.
 *
 * Add a new handler by importing it here and adding one entry to the
 * map — no other code change required.
 */
import { heliusTxDecoder } from "./helius-tx-decoder.js";
import type { InternalHandler } from "./types.js";

export const INTERNAL_HANDLERS: Record<string, InternalHandler> = {
  helius_tx_decoder: heliusTxDecoder,
};

export function getInternalHandler(name: string): InternalHandler | undefined {
  return INTERNAL_HANDLERS[name];
}
