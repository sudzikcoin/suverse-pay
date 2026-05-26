import { describe, expect, it, vi } from "vitest";
import { CDP_ERROR_REASON_MAP, mapCdpErrorReason, type CdpLogger } from "./error-map.js";

describe("mapCdpErrorReason", () => {
  it("maps the x402 spec error codes 1:1", () => {
    expect(mapCdpErrorReason("invalid_signature")).toBe("invalid_signature");
    expect(mapCdpErrorReason("invalid_authorization")).toBe("invalid_authorization");
    expect(mapCdpErrorReason("nonce_already_used")).toBe("nonce_already_used");
    expect(mapCdpErrorReason("expired_authorization")).toBe("expired_authorization");
    expect(mapCdpErrorReason("insufficient_funds")).toBe("insufficient_funds");
    expect(mapCdpErrorReason("unsupported_scheme")).toBe("unsupported_scheme");
    expect(mapCdpErrorReason("broadcast_failed")).toBe("broadcast_failed");
    expect(mapCdpErrorReason("unexpected_settle_error")).toBe("unexpected_settle_error");
  });

  it("normalizes EVM-specific reasons", () => {
    expect(mapCdpErrorReason("insufficient_allowance")).toBe("insufficient_grant");
    expect(mapCdpErrorReason("expired")).toBe("expired_authorization");
    expect(mapCdpErrorReason("invalid_exact_evm_payload")).toBe("invalid_authorization");
    expect(mapCdpErrorReason("invalid_exact_solana_payload")).toBe("invalid_authorization");
  });

  it("normalizes gateway-side reasons (auth / quota / rate-limit)", () => {
    expect(mapCdpErrorReason("unauthorized")).toBe("unauthorized");
    expect(mapCdpErrorReason("rate_limited")).toBe("rate_limited");
    expect(mapCdpErrorReason("quota_exceeded")).toBe("quota_exceeded");
  });

  it("maps unsupported_network to route_unsupported", () => {
    expect(mapCdpErrorReason("unsupported_network")).toBe("route_unsupported");
  });

  it("falls back to provider_internal_error on unknown reasons + emits a warning", () => {
    const logger: CdpLogger = { warn: vi.fn() };
    expect(mapCdpErrorReason("brand_new_failure", { logger })).toBe(
      "provider_internal_error",
    );
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("no warning on undefined / empty reason", () => {
    const warn = vi.fn();
    const logger: CdpLogger = { warn };
    expect(mapCdpErrorReason(undefined, { logger })).toBe("provider_internal_error");
    expect(mapCdpErrorReason("", { logger })).toBe("provider_internal_error");
    expect(warn).not.toHaveBeenCalled();
  });

  it("includes the unknown reason text in the warning context", () => {
    const warn = vi.fn();
    const logger: CdpLogger = { warn };
    mapCdpErrorReason("alien_code", {
      logger,
      context: { endpoint: "/settle", errorMessage: "details" },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("alien_code"),
      expect.objectContaining({ endpoint: "/settle" }),
    );
  });

  it("exports the dictionary with documented size", () => {
    expect(Object.keys(CDP_ERROR_REASON_MAP).length).toBeGreaterThanOrEqual(16);
  });
});
