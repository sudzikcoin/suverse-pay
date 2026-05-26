import type { ErrorCode } from "@suverse-pay/core-types";

/**
 * Maps cosmos-pay's wire-level errorReason / invalidReason strings to
 * our normalized ErrorCode.
 *
 * Source of truth: the 8 constants in
 * `/home/govhub/x402-cosmos/facilitator/types.go:97-106` plus
 * `"bad_request"` from `cmd/main.go:87` (sent on /settle with
 * malformed JSON body).
 *
 * Any reason not in this map is treated as a generic
 * `provider_internal_error` and the original string is preserved in
 * `errorMessage`. A warning is logged so an unknown reason from
 * cosmos-pay is visible in operator dashboards.
 */
export const COSMOS_PAY_ERROR_REASON_MAP: Readonly<Record<string, ErrorCode>> = {
  invalid_signature: "invalid_signature",
  invalid_authorization: "invalid_authorization",
  nonce_already_used: "nonce_already_used",
  expired_authorization: "expired_authorization",
  insufficient_grant: "insufficient_grant",
  insufficient_funds: "insufficient_funds",
  broadcast_failed: "broadcast_failed",
  unexpected_settle_error: "unexpected_settle_error",
  bad_request: "invalid_request",
};

const UNKNOWN_REASON_FALLBACK: ErrorCode = "provider_internal_error";

export interface CosmosPayLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

const defaultLogger: CosmosPayLogger = {
  warn: (message, context) => {
    if (context !== undefined) {
      console.warn(`[cosmos-pay-adapter] ${message}`, context);
    } else {
      console.warn(`[cosmos-pay-adapter] ${message}`);
    }
  },
};

export function mapCosmosPayErrorReason(
  reason: string | undefined,
  opts: { logger?: CosmosPayLogger; context?: Record<string, unknown> } = {},
): ErrorCode {
  if (reason === undefined || reason === "") {
    return UNKNOWN_REASON_FALLBACK;
  }
  const mapped = COSMOS_PAY_ERROR_REASON_MAP[reason];
  if (mapped !== undefined) {
    return mapped;
  }
  const logger = opts.logger ?? defaultLogger;
  logger.warn(
    `cosmos-pay returned an unknown errorReason: ${reason}`,
    opts.context,
  );
  return UNKNOWN_REASON_FALLBACK;
}
