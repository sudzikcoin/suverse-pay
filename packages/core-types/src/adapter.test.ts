import { describe, expect, it } from "vitest";
import {
  QuoteResponseSchema,
  SettleResponseSchema,
  SupportQuerySchema,
  VerifyResponseSchema,
} from "./adapter.js";
import { PaymentSchema } from "./payment.js";
import { DEFAULT_MERCHANT_POLICY, MerchantPolicySchema } from "./policy.js";

describe("adapter schemas", () => {
  it("SupportQuerySchema accepts a well-formed query", () => {
    const parsed = SupportQuerySchema.parse({
      network: "cosmos:noble-1",
      asset: "uusdc",
      scheme: "exact_cosmos_authz",
    });
    expect(parsed.network).toBe("cosmos:noble-1");
  });

  it("SupportQuerySchema rejects invalid network", () => {
    expect(() =>
      SupportQuerySchema.parse({
        network: "not_a_chain",
        asset: "uusdc",
        scheme: "x",
      }),
    ).toThrow();
  });

  it("QuoteResponseSchema requires source = native | synthetic", () => {
    const ok = QuoteResponseSchema.parse({
      providerId: "cosmos-pay",
      network: "cosmos:noble-1",
      asset: "uusdc",
      amount: "10000",
      estimatedFeeUsd: "0.0001",
      estimatedLatencyMs: 400,
      scheme: "exact_cosmos_authz",
      source: "synthetic",
    });
    expect(ok.source).toBe("synthetic");

    expect(() =>
      QuoteResponseSchema.parse({
        providerId: "x",
        network: "cosmos:noble-1",
        asset: "uusdc",
        amount: "10000",
        estimatedFeeUsd: "0.0001",
        estimatedLatencyMs: 400,
        scheme: "exact_cosmos_authz",
        source: "magic",
      }),
    ).toThrow();
  });

  it("VerifyResponseSchema accepts a typical OK response", () => {
    const parsed = VerifyResponseSchema.parse({
      valid: true,
      providerId: "cosmos-pay",
      payer: "noble1abc",
      verifiedAt: "2026-05-26T01:30:00Z",
    });
    expect(parsed.valid).toBe(true);
  });

  it("SettleResponseSchema can encode a failure with errorCode", () => {
    const parsed = SettleResponseSchema.parse({
      settled: false,
      providerId: "cosmos-pay",
      network: "cosmos:noble-1",
      amount: "10000",
      asset: "uusdc",
      errorCode: "nonce_already_used",
      errorMessage: "replay",
    });
    expect(parsed.errorCode).toBe("nonce_already_used");
  });
});

describe("payment schemas", () => {
  it("PaymentSchema accepts a settled payment with attempts", () => {
    const parsed = PaymentSchema.parse({
      paymentId: "pay_01HABC",
      apiKeyId: "apikey_admin_default",
      status: "settled",
      network: "cosmos:noble-1",
      asset: "uusdc",
      amount: "10000",
      recipient: "noble1recipient",
      createdAt: "2026-05-26T01:30:00Z",
      settledAt: "2026-05-26T01:30:02Z",
      attempts: [
        {
          attemptNumber: 1,
          providerId: "cosmos-pay",
          outcome: "success",
          latencyMs: 1340,
          startedAt: "2026-05-26T01:30:00Z",
          completedAt: "2026-05-26T01:30:02Z",
        },
      ],
    });
    expect(parsed.status).toBe("settled");
    expect(parsed.attempts).toHaveLength(1);
  });
});

describe("merchant policy", () => {
  it("applies defaults", () => {
    expect(DEFAULT_MERCHANT_POLICY).toEqual({
      optimize: "cost",
      fallback: true,
      maxAttempts: 3,
    });
  });

  it("respects explicit overrides", () => {
    const parsed = MerchantPolicySchema.parse({
      optimize: "latency",
      fallback: false,
      maxAttempts: 1,
    });
    expect(parsed.optimize).toBe("latency");
    expect(parsed.fallback).toBe(false);
    expect(parsed.maxAttempts).toBe(1);
  });

  it("clamps maxAttempts upper bound", () => {
    expect(() => MerchantPolicySchema.parse({ maxAttempts: 99 })).toThrow();
  });
});
