import type { ErrorCode } from "@suverse-pay/core-types";

/**
 * Wire-level error reason -> normalized ErrorCode for Binance x402.
 *
 * Binance's spec hasn't been published in detail; we mirror the
 * vocabulary CDP/PayAI/Thirdweb use and add Binance-Pay-specific
 * codes observed in their merchant API (BinancePay-Signature
 * validation failures, etc.). Unknown reasons fall back to
 * `provider_internal_error` with a warning so operators see new
 * codes when Binance publishes a final spec.
 */
export const BINANCE_ERROR_REASON_MAP: Readonly<Record<string, ErrorCode>> = {
  // x402 vocabulary
  invalid_signature: "invalid_signature",
  invalid_authorization: "invalid_authorization",
  invalid_permit: "invalid_authorization",
  nonce_already_used: "nonce_already_used",
  expired_authorization: "expired_authorization",
  expired_permit: "expired_authorization",
  insufficient_grant: "insufficient_grant",
  insufficient_allowance: "insufficient_grant",
  insufficient_funds: "insufficient_funds",
  broadcast_failed: "broadcast_failed",
  simulation_failed: "broadcast_failed",
  unexpected_settle_error: "unexpected_settle_error",
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
  // Binance Pay-specific (observed in their merchant API docs)
  signature_invalid: "invalid_request",
  certificate_sn_invalid: "unauthorized",
  timestamp_expired: "expired_authorization",
  merchant_not_authorized: "unauthorized",
};

const UNKNOWN_REASON_FALLBACK: ErrorCode = "provider_internal_error";

export interface BinanceLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

const defaultLogger: BinanceLogger = {
  warn: (message, context) => {
    if (context !== undefined) {
      console.warn(`[binance-x402-adapter] ${message}`, context);
    } else {
      console.warn(`[binance-x402-adapter] ${message}`);
    }
  },
};

export function mapBinanceErrorReason(
  reason: string | undefined,
  opts: { logger?: BinanceLogger; context?: Record<string, unknown> } = {},
): ErrorCode {
  if (reason === undefined || reason === "") {
    return UNKNOWN_REASON_FALLBACK;
  }
  const mapped = BINANCE_ERROR_REASON_MAP[reason];
  if (mapped !== undefined) return mapped;
  const logger = opts.logger ?? defaultLogger;
  logger.warn(`Binance x402 returned an unknown errorReason: ${reason}`, opts.context);
  return UNKNOWN_REASON_FALLBACK;
}
