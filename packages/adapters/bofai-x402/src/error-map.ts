import type { ErrorCode } from "@suverse-pay/core-types";

/**
 * Wire-level error reason -> normalized ErrorCode for BofAI x402.
 *
 * BofAI uses the canonical x402 v2 facilitator error vocabulary; the
 * mapping mostly mirrors PayAI/Thirdweb/Binance. TRON-specific reasons
 * surface from the GasFree path (gasfree_inactive_account,
 * insufficient_gasfree_balance, etc.) — recorded inline alongside the
 * EVM vocabulary.
 */
export const BOFAI_ERROR_REASON_MAP: Readonly<Record<string, ErrorCode>> = {
  // EVM / signature path (shared with BSC routing)
  invalid_signature: "invalid_signature",
  invalid_authorization: "invalid_authorization",
  invalid_permit: "invalid_authorization",
  nonce_already_used: "nonce_already_used",
  expired_authorization: "expired_authorization",
  expired_permit: "expired_authorization",
  insufficient_grant: "insufficient_grant",
  insufficient_allowance: "insufficient_grant",
  insufficient_funds: "insufficient_funds",
  // GasFree (TRON) specific
  gasfree_inactive_account: "invalid_authorization",
  gasfree_submit_blocked: "invalid_authorization",
  insufficient_gasfree_balance: "insufficient_funds",
  insufficient_maxfee: "insufficient_funds",
  // Settlement / chain layer
  broadcast_failed: "broadcast_failed",
  simulation_failed: "broadcast_failed",
  energy_exhausted: "broadcast_failed",
  bandwidth_exhausted: "broadcast_failed",
  unexpected_settle_error: "unexpected_settle_error",
  // Generic / request-layer
  bad_request: "invalid_request",
  invalid_request: "invalid_request",
  invalid_payload: "invalid_request",
  unauthorized: "unauthorized",
  not_found: "not_found",
  rate_limited: "rate_limited",
  quota_exceeded: "quota_exceeded",
  unsupported_scheme: "unsupported_scheme",
  unsupported_network: "route_unsupported",
  route_unsupported: "route_unsupported",
  temporary_unavailable: "temporary_unavailable",
};

const UNKNOWN_REASON_FALLBACK: ErrorCode = "provider_internal_error";

export interface BofaiLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

const defaultLogger: BofaiLogger = {
  warn: (message, context) => {
    if (context !== undefined) {
      console.warn(`[bofai-x402-adapter] ${message}`, context);
    } else {
      console.warn(`[bofai-x402-adapter] ${message}`);
    }
  },
};

export function mapBofaiErrorReason(
  reason: string | undefined,
  opts: { logger?: BofaiLogger; context?: Record<string, unknown> } = {},
): ErrorCode {
  if (reason === undefined || reason === "") {
    return UNKNOWN_REASON_FALLBACK;
  }
  const mapped = BOFAI_ERROR_REASON_MAP[reason];
  if (mapped !== undefined) return mapped;
  const logger = opts.logger ?? defaultLogger;
  logger.warn(`BofAI x402 returned an unknown errorReason: ${reason}`, opts.context);
  return UNKNOWN_REASON_FALLBACK;
}
