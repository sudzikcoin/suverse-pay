import type { ErrorCode } from "@suverse-pay/core-types";

/**
 * Wire-level error reason -> normalized ErrorCode for t402-io.
 *
 * t402-io adopts the canonical x402 error vocabulary verbatim — the
 * mapping mirrors PayAI / Thirdweb / BofAI. Multi-VM specific reasons
 * surface from the non-EVM mechanisms (ton, near, aptos, etc.) and
 * are captured alongside the EVM vocabulary.
 */
export const T402_ERROR_REASON_MAP: Readonly<Record<string, ErrorCode>> = {
  // EVM / signature path
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
  // Multi-VM specific (TON / TRON / Stellar / etc — best-effort
  // mapping; unknowns fall through to provider_internal_error).
  ton_bridge_error: "broadcast_failed",
  jetton_transfer_failed: "broadcast_failed",
  near_storage_deposit_required: "insufficient_funds",
  aptos_sequence_mismatch: "nonce_already_used",
  tezos_counter_in_past: "nonce_already_used",
  stellar_horizon_unreachable: "temporary_unavailable",
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

export interface T402Logger {
  warn(message: string, context?: Record<string, unknown>): void;
}

const defaultLogger: T402Logger = {
  warn: (message, context) => {
    if (context !== undefined) {
      console.warn(`[t402-io-adapter] ${message}`, context);
    } else {
      console.warn(`[t402-io-adapter] ${message}`);
    }
  },
};

export function mapT402ErrorReason(
  reason: string | undefined,
  opts: { logger?: T402Logger; context?: Record<string, unknown> } = {},
): ErrorCode {
  if (reason === undefined || reason === "") {
    return UNKNOWN_REASON_FALLBACK;
  }
  const mapped = T402_ERROR_REASON_MAP[reason];
  if (mapped !== undefined) return mapped;
  const logger = opts.logger ?? defaultLogger;
  logger.warn(`t402-io returned an unknown errorReason: ${reason}`, opts.context);
  return UNKNOWN_REASON_FALLBACK;
}
