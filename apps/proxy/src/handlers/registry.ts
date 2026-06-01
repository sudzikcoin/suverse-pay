/**
 * Name → handler registry consulted when a `seller_proxy_configs` row
 * has `internal_handler` set. Single source of truth for legal handler
 * names; anything else surfaces as 503 + a log line, so a typo in the
 * DB column cannot silently fall through to the upstream HTTP path.
 *
 * Add a new handler by importing it here and adding one entry to the
 * map — no other code change required.
 */
import { heliusNftMetadata } from "./helius-nft-metadata.js";
import { heliusPriorityFee } from "./helius-priority-fee.js";
import { heliusTxDecoder } from "./helius-tx-decoder.js";
import { heliusTxSimulator } from "./helius-tx-simulator.js";
import { heliusWalletHistory } from "./helius-wallet-history.js";
import type { InternalHandler } from "./types.js";

export const INTERNAL_HANDLERS: Record<string, InternalHandler> = {
  helius_tx_decoder: heliusTxDecoder,
  helius_tx_simulator: heliusTxSimulator,
  helius_priority_fee: heliusPriorityFee,
  helius_nft_metadata: heliusNftMetadata,
  helius_wallet_history: heliusWalletHistory,
};

export function getInternalHandler(name: string): InternalHandler | undefined {
  return INTERNAL_HANDLERS[name];
}
