import type { ErrorCode } from "@suverse-pay/core-types";

/**
 * Maps PayAI's wire-level errorReason / invalidReason strings to our
 * normalized ErrorCode.
 *
 * PayAI implements the same canonical x402 v2 facilitator error
 * vocabulary as Coinbase CDP and cosmos-pay, so the mapping is largely
 * 1:1. Solana-specific reasons (`broadcast_failed` for blockhash
 * expiry, `duplicate_settlement` for the SVM-spec race-mitigation
 * cache) are captured alongside EVM reasons. Anything unrecognized
 * falls back to `provider_internal_error` with a warning so operators
 * see new codes in dashboards.
 */
export const PAYAI_ERROR_REASON_MAP: Readonly<Record<string, ErrorCode>> = {
  // EVM signature path
  invalid_signature: "invalid_signature",
  invalid_authorization: "invalid_authorization",
  nonce_already_used: "nonce_already_used",
  expired_authorization: "expired_authorization",
  insufficient_grant: "insufficient_grant",
  insufficient_allowance: "insufficient_grant",
  insufficient_funds: "insufficient_funds",
  // Settlement / chain layer
  broadcast_failed: "broadcast_failed",
  unexpected_settle_error: "unexpected_settle_error",
  // SVM-specific (per scheme_exact_svm.md "Duplicate Settlement Mitigation")
  duplicate_settlement: "duplicate_idempotency_key",
  // Generic / request-layer
  bad_request: "invalid_request",
  invalid_request: "invalid_request",
  unauthorized: "unauthorized",
  not_found: "not_found",
  rate_limited: "rate_limited",
  quota_exceeded: "quota_exceeded",
  unsupported_scheme: "unsupported_scheme",
  route_unsupported: "route_unsupported",
  temporary_unavailable: "temporary_unavailable",
};

const UNKNOWN_REASON_FALLBACK: ErrorCode = "provider_internal_error";

export interface PayAiLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

const defaultLogger: PayAiLogger = {
  warn: (message, context) => {
    if (context !== undefined) {
      console.warn(`[payai-adapter] ${message}`, context);
    } else {
      console.warn(`[payai-adapter] ${message}`);
    }
  },
};

export function mapPayAiErrorReason(
  reason: string | undefined,
  opts: { logger?: PayAiLogger; context?: Record<string, unknown> } = {},
): ErrorCode {
  if (reason === undefined || reason === "") {
    return UNKNOWN_REASON_FALLBACK;
  }
  const mapped = PAYAI_ERROR_REASON_MAP[reason];
  if (mapped !== undefined) return mapped;
  const logger = opts.logger ?? defaultLogger;
  logger.warn(
    `PayAI returned an unknown errorReason: ${reason}`,
    opts.context,
  );
  return UNKNOWN_REASON_FALLBACK;
}
