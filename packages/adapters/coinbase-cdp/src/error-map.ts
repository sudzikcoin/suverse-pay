import type { ErrorCode } from "@suverse-pay/core-types";

/**
 * Maps CDP's wire-level errorReason / invalidReason strings to our
 * normalized ErrorCode.
 *
 * Coinbase has not published a public closed list of x402 error reason
 * strings. This map is built from the x402 v2 spec and from the
 * scheme implementations in `coinbase/x402` on GitHub. Reasons not in
 * the map fall through to `provider_internal_error` with the original
 * string preserved in `errorMessage`, and a warning is emitted so an
 * unknown reason from CDP is immediately visible in operator
 * dashboards.
 */
export const CDP_ERROR_REASON_MAP: Readonly<Record<string, ErrorCode>> = {
  // x402 spec — generic
  invalid_signature: "invalid_signature",
  invalid_authorization: "invalid_authorization",
  nonce_already_used: "nonce_already_used",
  expired_authorization: "expired_authorization",
  insufficient_funds: "insufficient_funds",
  unsupported_scheme: "unsupported_scheme",
  unsupported_network: "route_unsupported",
  broadcast_failed: "broadcast_failed",
  unexpected_settle_error: "unexpected_settle_error",
  bad_request: "invalid_request",

  // EVM exact scheme variants — these surface when EIP-3009 / Permit2
  // preconditions don't hold.
  insufficient_allowance: "insufficient_grant",
  expired: "expired_authorization",
  invalid_exact_evm_payload: "invalid_authorization",
  invalid_exact_solana_payload: "invalid_authorization",

  // Auth / quota failures returned by the CDP gateway itself.
  unauthorized: "unauthorized",
  rate_limited: "rate_limited",
  quota_exceeded: "quota_exceeded",
};

const UNKNOWN_REASON_FALLBACK: ErrorCode = "provider_internal_error";

export interface CdpLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

const defaultLogger: CdpLogger = {
  warn: (message, context) => {
    if (context !== undefined) {
      console.warn(`[coinbase-cdp-adapter] ${message}`, context);
    } else {
      console.warn(`[coinbase-cdp-adapter] ${message}`);
    }
  },
};

export function mapCdpErrorReason(
  reason: string | undefined,
  opts: { logger?: CdpLogger; context?: Record<string, unknown> } = {},
): ErrorCode {
  if (reason === undefined || reason === "") {
    return UNKNOWN_REASON_FALLBACK;
  }
  const mapped = CDP_ERROR_REASON_MAP[reason];
  if (mapped !== undefined) {
    return mapped;
  }
  const logger = opts.logger ?? defaultLogger;
  logger.warn(`CDP returned an unknown errorReason: ${reason}`, opts.context);
  return UNKNOWN_REASON_FALLBACK;
}
