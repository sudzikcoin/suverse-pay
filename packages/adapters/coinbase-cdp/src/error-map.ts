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
  // CDP's generic "the payload does not verify" reason. On its own it
  // is an authorization problem; when the message says the simulated
  // transfer reverted it is the payer's balance — see
  // mapCdpVerifyRejection.
  invalid_payload: "invalid_authorization",

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

/**
 * `invalidMessage` fragments CDP attaches to `invalid_payload` when the
 * simulated EIP-3009 / SPL transfer reverts. For an otherwise
 * well-formed authorization that is, in practice, the payer not
 * holding the amount: reproduced 2026-09-07 with a $100 authorization
 * from a wallet holding $7.85 → HTTP 400
 * `{"invalidReason":"invalid_payload","invalidMessage":"contract call
 * failed: unable to call contract: execution reverted"}`. The exact
 * wallet 0x8a1A… (0.000008 USDC) hit the same body every 4 h for three
 * weeks and was answered with an opaque 502.
 */
const CONTRACT_REVERT_FRAGMENTS: ReadonlyArray<RegExp> = [
  /execution reverted/i,
  /contract call failed/i,
  /transfer amount exceeds balance/i,
  /insufficient (funds|balance)/i,
];

/**
 * Map a CDP /verify rejection (`isValid:false`) to our ErrorCode,
 * refining the generic `invalid_payload` into `insufficient_funds`
 * when the message shows the transfer simulation reverted. The
 * original CDP text is always preserved by the caller in
 * `errorMessage`; this only picks the code.
 */
export function mapCdpVerifyRejection(
  reason: string | undefined,
  message: string | undefined,
  opts: { logger?: CdpLogger; context?: Record<string, unknown> } = {},
): ErrorCode {
  if (
    reason === "invalid_payload" &&
    message !== undefined &&
    CONTRACT_REVERT_FRAGMENTS.some((re) => re.test(message))
  ) {
    return "insufficient_funds";
  }
  return mapCdpErrorReason(reason, opts);
}
