import { describe, expect, it } from "vitest";
import {
  ALL_ERROR_CODES,
  ErrorCodeSchema,
  GatewayError,
  ProviderError,
  isRetryableErrorCode,
  type ErrorCode,
} from "./errors.js";

describe("error codes", () => {
  it("classifies the five retryable codes per TASK.md", () => {
    const retryable: ErrorCode[] = [
      "network_error",
      "timeout",
      "provider_internal_error",
      "temporary_unavailable",
      "rate_limited",
    ];
    for (const code of retryable) {
      expect(isRetryableErrorCode(code)).toBe(true);
    }
  });

  it("treats every other code as non-retryable", () => {
    const nonRetryable: ErrorCode[] = [
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
    ];
    for (const code of nonRetryable) {
      expect(isRetryableErrorCode(code)).toBe(false);
    }
  });

  it("exposes every documented code in ALL_ERROR_CODES", () => {
    // sanity: tuple length matches the listed codes above (5 retryable + 15 non-retryable)
    expect(ALL_ERROR_CODES).toHaveLength(20);
    expect(new Set(ALL_ERROR_CODES).size).toBe(ALL_ERROR_CODES.length);
  });

  it("ErrorCodeSchema parses any listed code", () => {
    for (const code of ALL_ERROR_CODES) {
      expect(ErrorCodeSchema.parse(code)).toBe(code);
    }
  });

  it("ErrorCodeSchema rejects unknown codes", () => {
    expect(() => ErrorCodeSchema.parse("made_up_code")).toThrow();
  });

  describe("ProviderError", () => {
    it("preserves code and reports retryability", () => {
      const err = new ProviderError("timeout", "took too long", {
        providerId: "coinbase-cdp",
      });
      expect(err.code).toBe("timeout");
      expect(err.providerId).toBe("coinbase-cdp");
      expect(err.isRetryable()).toBe(true);
    });

    it("non-retryable codes return false from isRetryable", () => {
      const err = new ProviderError("invalid_signature", "bad sig");
      expect(err.isRetryable()).toBe(false);
    });
  });

  describe("GatewayError", () => {
    it("carries an HTTP status", () => {
      const err = new GatewayError("unauthorized", 401, "no key");
      expect(err.code).toBe("unauthorized");
      expect(err.httpStatus).toBe(401);
    });
  });
});
