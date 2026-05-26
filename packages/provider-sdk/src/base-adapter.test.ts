import type {
  GetStatusHints,
  HealthStatus,
  QuoteRequest,
  QuoteResponse,
  SettleOptions,
  SettleRequest,
  SettleResponse,
  StatusResponse,
  VerifyRequest,
  VerifyResponse,
} from "@suverse-pay/core-types";
import { describe, expect, it } from "vitest";
import { BaseAdapter } from "./base-adapter.js";

class TestAdapter extends BaseAdapter {
  readonly id = "test-adapter";
  readonly displayName = "Test Adapter";
  public lastSettleOpts: SettleOptions | undefined;

  override async quote(req: QuoteRequest): Promise<QuoteResponse> {
    return {
      providerId: this.id,
      network: req.network,
      asset: req.asset,
      amount: req.amount,
      estimatedFeeUsd: "0.001",
      estimatedLatencyMs: 100,
      scheme: req.scheme,
      source: "synthetic",
    };
  }

  override async verify(req: VerifyRequest): Promise<VerifyResponse> {
    return {
      valid: true,
      providerId: this.id,
      verifiedAt: new Date().toISOString(),
    };
  }

  override async settle(
    req: SettleRequest,
    opts?: SettleOptions,
  ): Promise<SettleResponse> {
    this.lastSettleOpts = opts;
    return {
      settled: true,
      providerId: this.id,
      network: req.paymentRequirements.network,
      amount: req.paymentRequirements.maxAmountRequired,
      asset: req.paymentRequirements.asset,
      txHash: "0xdeadbeef",
      settledAt: new Date().toISOString(),
    };
  }

  override async getStatus(
    providerPaymentId: string,
    hints?: GetStatusHints,
  ): Promise<StatusResponse> {
    return {
      providerId: this.id,
      providerPaymentId,
      status: hints?.txHash !== undefined ? "settled" : "pending",
      ...(hints?.txHash !== undefined ? { txHash: hints.txHash } : {}),
    };
  }

  override async healthCheck(): Promise<HealthStatus> {
    return {
      status: "healthy",
      latencyMs: 50,
      checkedAt: new Date().toISOString(),
    };
  }
}

describe("BaseAdapter", () => {
  const adapter = new TestAdapter({
    staticCapabilities: [
      { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      { network: "cosmos:grand-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
    ],
  });

  describe("supports()", () => {
    it("returns true for an exact static-cap match", async () => {
      const result = await adapter.supports({
        network: "cosmos:noble-1",
        asset: "uusdc",
        scheme: "exact_cosmos_authz",
      });
      expect(result.supported).toBe(true);
    });

    it("returns false on any field mismatch", async () => {
      expect(
        (await adapter.supports({
          network: "cosmos:noble-1",
          asset: "uusdc",
          scheme: "exact_evm",
        })).supported,
      ).toBe(false);
      expect(
        (await adapter.supports({
          network: "cosmos:noble-1",
          asset: "uatom",
          scheme: "exact_cosmos_authz",
        })).supported,
      ).toBe(false);
      expect(
        (await adapter.supports({
          network: "eip155:8453",
          asset: "uusdc",
          scheme: "exact_cosmos_authz",
        })).supported,
      ).toBe(false);
    });
  });

  it("settle receives the optional idempotencyKey from the caller", async () => {
    await adapter.settle(
      {
        paymentPayload: {
          x402Version: 2,
          scheme: "exact_cosmos_authz",
          network: "cosmos:noble-1",
          payload: {},
        },
        paymentRequirements: {
          scheme: "exact_cosmos_authz",
          network: "cosmos:noble-1",
          maxAmountRequired: "10000",
          asset: "uusdc",
          payTo: "noble1recipient",
          resource: "https://x/y",
        },
      },
      { idempotencyKey: "key-123" },
    );
    expect(adapter.lastSettleOpts?.idempotencyKey).toBe("key-123");
  });

  it("settle works without idempotencyKey", async () => {
    await adapter.settle({
      paymentPayload: {
        x402Version: 2,
        scheme: "exact_cosmos_authz",
        network: "cosmos:noble-1",
        payload: {},
      },
      paymentRequirements: {
        scheme: "exact_cosmos_authz",
        network: "cosmos:noble-1",
        maxAmountRequired: "10000",
        asset: "uusdc",
        payTo: "noble1recipient",
        resource: "https://x/y",
      },
    });
    expect(adapter.lastSettleOpts).toBeUndefined();
  });

  it("exposes static capabilities via the protected helper", () => {
    class Exposed extends TestAdapter {
      list() {
        return this.staticCapabilitiesAsDiscovered();
      }
    }
    const a = new Exposed({
      staticCapabilities: [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ],
    });
    expect(a.list()).toEqual([
      { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
    ]);
  });
});
