import { describe, expect, it, vi } from "vitest";
import {
  COSMOS_PAY_ERROR_REASON_MAP,
  mapCosmosPayErrorReason,
  type CosmosPayLogger,
} from "./error-map.js";

describe("mapCosmosPayErrorReason", () => {
  it("maps every documented cosmos-pay reason 1:1", () => {
    expect(mapCosmosPayErrorReason("invalid_signature")).toBe("invalid_signature");
    expect(mapCosmosPayErrorReason("invalid_authorization")).toBe("invalid_authorization");
    expect(mapCosmosPayErrorReason("nonce_already_used")).toBe("nonce_already_used");
    expect(mapCosmosPayErrorReason("expired_authorization")).toBe("expired_authorization");
    expect(mapCosmosPayErrorReason("insufficient_grant")).toBe("insufficient_grant");
    expect(mapCosmosPayErrorReason("insufficient_funds")).toBe("insufficient_funds");
    expect(mapCosmosPayErrorReason("broadcast_failed")).toBe("broadcast_failed");
    expect(mapCosmosPayErrorReason("unexpected_settle_error")).toBe("unexpected_settle_error");
  });

  it("maps cosmos-pay's `bad_request` to invalid_request", () => {
    expect(mapCosmosPayErrorReason("bad_request")).toBe("invalid_request");
  });

  it("falls back to provider_internal_error for unknown reasons", () => {
    const logger: CosmosPayLogger = { warn: vi.fn() };
    const result = mapCosmosPayErrorReason("totally_new_reason", { logger });
    expect(result).toBe("provider_internal_error");
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("logs a warning with context on unknown reasons", () => {
    const warn = vi.fn();
    const logger: CosmosPayLogger = { warn };
    mapCosmosPayErrorReason("alien_code", {
      logger,
      context: { endpoint: "/settle" },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("alien_code"),
      { endpoint: "/settle" },
    );
  });

  it("handles undefined and empty reason as fallback (no warning)", () => {
    const warn = vi.fn();
    const logger: CosmosPayLogger = { warn };
    expect(mapCosmosPayErrorReason(undefined, { logger })).toBe(
      "provider_internal_error",
    );
    expect(mapCosmosPayErrorReason("", { logger })).toBe("provider_internal_error");
    expect(warn).not.toHaveBeenCalled();
  });

  it("exports a frozen-style map (typed Readonly)", () => {
    expect(Object.keys(COSMOS_PAY_ERROR_REASON_MAP)).toHaveLength(9);
    expect(COSMOS_PAY_ERROR_REASON_MAP["invalid_signature"]).toBe("invalid_signature");
  });
});
