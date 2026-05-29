import type { ErrorCode } from "@suverse-pay/core-types";

/**
 * Maps Thirdweb's wire-level errorReason / invalidReason strings to our
 * normalized ErrorCode.
 *
 * Thirdweb implements the canonical x402 v2 facilitator error vocabulary
 * — the same one Coinbase CDP and PayAI use — so the mapping is largely
 * 1:1. Anything unrecognized falls back to `provider_internal_error`
 * with a warning so operators see new codes appear in dashboards.
 */
export const THIRDWEB_ERROR_REASON_MAP: Readonly<Record<string, ErrorCode>> = {
  // EVM signature path (EIP-3009 + EIP-2612)
  invalid_signature: "invalid_signature",
  invalid_authorization: "invalid_authorization",
  invalid_permit: "invalid_authorization",
  nonce_already_used: "nonce_already_used",
  expired_authorization: "expired_authorization",
  expired_permit: "expired_authorization",
  insufficient_grant: "insufficient_grant",
  insufficient_allowance: "insufficient_grant",
  insufficient_funds: "insufficient_funds",
  // Settlement / chain layer
  broadcast_failed: "broadcast_failed",
  simulation_failed: "broadcast_failed",
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

export interface ThirdwebLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

const defaultLogger: ThirdwebLogger = {
  warn: (message, context) => {
    if (context !== undefined) {
      console.warn(`[thirdweb-x402-adapter] ${message}`, context);
    } else {
      console.warn(`[thirdweb-x402-adapter] ${message}`);
    }
  },
};

export function mapThirdwebErrorReason(
  reason: string | undefined,
  opts: { logger?: ThirdwebLogger; context?: Record<string, unknown> } = {},
): ErrorCode {
  if (reason === undefined || reason === "") {
    return UNKNOWN_REASON_FALLBACK;
  }
  const mapped = THIRDWEB_ERROR_REASON_MAP[reason];
  if (mapped !== undefined) return mapped;
  const logger = opts.logger ?? defaultLogger;
  logger.warn(`Thirdweb returned an unknown errorReason: ${reason}`, opts.context);
  return UNKNOWN_REASON_FALLBACK;
}
