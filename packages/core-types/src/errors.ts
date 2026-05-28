import { z } from "zod";

export const ALL_ERROR_CODES = [
  "network_error",
  "timeout",
  "provider_internal_error",
  "temporary_unavailable",
  "rate_limited",

  "route_unsupported",
  "invalid_signature",
  "invalid_authorization",
  "nonce_already_used",
  "expired_authorization",
  "insufficient_funds",
  "insufficient_grant",
  "broadcast_failed",
  "quota_exceeded",
  "unsupported_scheme",

  "invalid_request",
  "unauthorized",
  "not_found",
  "duplicate_idempotency_key",
  "unexpected_settle_error",
] as const;

export type ErrorCode = (typeof ALL_ERROR_CODES)[number];

export const ErrorCodeSchema = z.enum(ALL_ERROR_CODES);

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "network_error",
  "timeout",
  "provider_internal_error",
  "temporary_unavailable",
  "rate_limited",
]);

export function isRetryableErrorCode(code: ErrorCode): boolean {
  return RETRYABLE.has(code);
}

export class ProviderError extends Error {
  public readonly code: ErrorCode;
  public readonly providerId?: string;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { providerId?: string; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ProviderError";
    this.code = code;
    if (options?.providerId !== undefined) {
      this.providerId = options.providerId;
    }
  }

  isRetryable(): boolean {
    return isRetryableErrorCode(this.code);
  }
}

export class GatewayError extends Error {
  public readonly code: ErrorCode;
  public readonly httpStatus: number;
  /**
   * When set, the global error handler emits a `Retry-After: <n>`
   * response header. Used by rate-limited / temporarily-unavailable
   * branches so callers receive an actionable retry hint without
   * parsing the message body.
   */
  public readonly retryAfterSeconds?: number;

  constructor(
    code: ErrorCode,
    httpStatus: number,
    message: string,
    options?: { cause?: unknown; retryAfterSeconds?: number },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "GatewayError";
    this.code = code;
    this.httpStatus = httpStatus;
    if (options?.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}
