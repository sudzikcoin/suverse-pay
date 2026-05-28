import {
  ProviderError,
  type ProviderAdapter,
  type SettleRequest,
  type SettleResponse,
} from "@suverse-pay/core-types";
import type { RegisteredProvider } from "@suverse-pay/orchestrator";
import { describe, expect, it, vi } from "vitest";
import { routeSettleWithFailover, pickAdaptersForRoute } from "./router.js";

// Build a fake RegisteredProvider with a stubbed adapter.settle.
function fakeRegisteredProvider(
  id: string,
  settle: (req: SettleRequest) => Promise<SettleResponse>,
  enabled = true,
): RegisteredProvider {
  return {
    id,
    displayName: id,
    enabled,
    adapter: {
      id,
      displayName: id,
      supports: vi.fn(),
      quote: vi.fn(),
      verify: vi.fn(),
      settle,
      getStatus: vi.fn(),
      healthCheck: vi.fn(),
    } as unknown as ProviderAdapter,
  } as RegisteredProvider;
}

// Minimal in-memory registry matching the subset of ProviderRegistry
// the router uses.
function fakeRegistry(providers: ReadonlyArray<RegisteredProvider>) {
  const byId = new Map(providers.map((p) => [p.id, p]));
  return {
    getById: (id: string) => byId.get(id),
    enabled: () => providers.filter((p) => p.enabled),
    list: () => providers,
    listCapabilities: async () => [],
    register: async () => {},
    setEnabled: async () => {},
    deregister: async () => {},
  } as never;
}

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

function svmSettleReq(): SettleRequest {
  return {
    paymentPayload: {
      x402Version: 2,
      scheme: "exact",
      network: SOLANA_MAINNET,
      payload: { transaction: "AAAA" },
    },
    paymentRequirements: {
      scheme: "exact",
      network: SOLANA_MAINNET,
      maxAmountRequired: "1000",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      payTo: "noble1recipient",
      resource: "https://example.com/x",
      maxTimeoutSeconds: 60,
      extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" },
    },
  } as never;
}

describe("ROUTING_CONFIG static entries", () => {
  // Lock in CDP-routable EVM networks so a config refactor can't
  // silently drop them. Mirrors the (network, scheme) pairs CDP
  // /supported advertises for x402 v2.
  const expectedEvmRoutes = [
    "eip155:8453:exact",      // Base mainnet
    "eip155:137:exact",       // Polygon
    "eip155:42161:exact",     // Arbitrum
    "eip155:84532:exact",     // Base Sepolia (v0.3.1)
    "eip155:480:exact",       // World Chain mainnet (v0.3.2)
    "eip155:4801:exact",      // World Sepolia (v0.3.2)
  ];
  for (const key of expectedEvmRoutes) {
    it(`routes ${key} to coinbase-cdp`, async () => {
      // Dynamic import — the routing-config module owns the static
      // table and is the source of truth.
      const { getRoutingPriority } = await import("./routing-config.js");
      const [network, scheme] = key.split(":exact").map((s, i) => i === 0 ? s : "exact");
      const priority = getRoutingPriority(network!, "exact");
      expect(priority?.[0]).toBe("coinbase-cdp");
    });
  }
});

describe("pickAdaptersForRoute", () => {
  it("returns adapters in routing-config priority order, primary first", () => {
    const cdp = fakeRegisteredProvider("coinbase-cdp", async () => ({}) as never);
    const payai = fakeRegisteredProvider("payai", async () => ({}) as never);
    const registry = fakeRegistry([payai, cdp]); // registered in non-priority order
    const { candidates } = pickAdaptersForRoute(registry, {
      network: SOLANA_MAINNET,
      scheme: "exact",
    });
    expect(candidates.map((c) => c.id)).toEqual(["coinbase-cdp", "payai"]);
  });

  it("returns empty + 'no_routing_config' for an unrecognized route", () => {
    const registry = fakeRegistry([]);
    const result = pickAdaptersForRoute(registry, {
      network: "eip155:99999",
      scheme: "exact",
    });
    expect(result.candidates).toEqual([]);
    expect(result.reason).toBe("no_routing_config");
  });

  it("skips disabled adapters but keeps the rest in priority order", () => {
    const cdp = fakeRegisteredProvider("coinbase-cdp", async () => ({}) as never, false);
    const payai = fakeRegisteredProvider("payai", async () => ({}) as never);
    const registry = fakeRegistry([cdp, payai]);
    const { candidates } = pickAdaptersForRoute(registry, {
      network: SOLANA_MAINNET,
      scheme: "exact",
    });
    expect(candidates.map((c) => c.id)).toEqual(["payai"]);
  });

  it("returns 'no_registered_adapter' when no priority adapter is registered", () => {
    const registry = fakeRegistry([]);
    const result = pickAdaptersForRoute(registry, {
      network: SOLANA_MAINNET,
      scheme: "exact",
    });
    expect(result.reason).toBe("no_registered_adapter");
  });
});

describe("routeSettleWithFailover", () => {
  it("returns the primary's success without trying the failover", async () => {
    const primarySettle = vi.fn(async (): Promise<SettleResponse> => ({
      settled: true,
      providerId: "coinbase-cdp",
      txHash: "0xprimary-tx",
      network: SOLANA_MAINNET,
      amount: "1000",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    } as never));
    const failoverSettle = vi.fn();
    const cdp = fakeRegisteredProvider("coinbase-cdp", primarySettle);
    const payai = fakeRegisteredProvider("payai", failoverSettle);
    const registry = fakeRegistry([cdp, payai]);

    const result = await routeSettleWithFailover(svmSettleReq(), {
      registry,
      idempotencyKey: "idem-1",
    });
    expect(result.adapterUsed).toBe("coinbase-cdp");
    expect(result.failoverFrom).toEqual([]);
    expect(result.response.settled).toBe(true);
    expect(primarySettle).toHaveBeenCalledOnce();
    expect(failoverSettle).not.toHaveBeenCalled();
  });

  it("falls over from primary to backup on a retryable error AND reuses the same idempotency key", async () => {
    const primaryCalls: SettleRequest[] = [];
    const backupCalls: SettleRequest[] = [];
    const primarySettle = vi.fn(async (req: SettleRequest) => {
      primaryCalls.push(req);
      return {
        settled: false,
        providerId: "coinbase-cdp",
        network: SOLANA_MAINNET,
        amount: "1000",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        errorCode: "temporary_unavailable",
        errorMessage: "CDP rate limited",
      } as never as SettleResponse;
    });
    const backupSettle = vi.fn(async (req: SettleRequest) => {
      backupCalls.push(req);
      return {
        settled: true,
        providerId: "payai",
        txHash: "BackupSig",
        network: SOLANA_MAINNET,
        amount: "1000",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      } as never as SettleResponse;
    });
    const cdp = fakeRegisteredProvider("coinbase-cdp", primarySettle);
    const payai = fakeRegisteredProvider("payai", backupSettle);
    const registry = fakeRegistry([cdp, payai]);

    const result = await routeSettleWithFailover(svmSettleReq(), {
      registry,
      idempotencyKey: "idem-shared",
    });
    expect(result.adapterUsed).toBe("payai");
    expect(result.failoverFrom).toEqual([
      {
        adapterId: "coinbase-cdp",
        errorCode: "temporary_unavailable",
        errorMessage: "CDP rate limited",
      },
    ]);
    expect(result.response.settled).toBe(true);
    // Idempotency-Key MUST be the same on both attempts so adapters
    // that honour it can avoid double-broadcast.
    expect(primarySettle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: "idem-shared" }),
    );
    expect(backupSettle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: "idem-shared" }),
    );
  });

  it("does NOT fall over on a terminal (non-retryable) error", async () => {
    const primarySettle = vi.fn(async (): Promise<SettleResponse> => ({
      settled: false,
      providerId: "coinbase-cdp",
      network: SOLANA_MAINNET,
      amount: "1000",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      errorCode: "invalid_signature",
      errorMessage: "signature did not recover",
    } as never));
    const backupSettle = vi.fn();
    const cdp = fakeRegisteredProvider("coinbase-cdp", primarySettle);
    const payai = fakeRegisteredProvider("payai", backupSettle);
    const registry = fakeRegistry([cdp, payai]);

    const result = await routeSettleWithFailover(svmSettleReq(), {
      registry,
      idempotencyKey: "idem",
    });
    expect(result.adapterUsed).toBe("coinbase-cdp");
    expect(result.failoverFrom).toEqual([]);
    expect(result.response.settled).toBe(false);
    expect(backupSettle).not.toHaveBeenCalled();
  });

  it("treats settled=true + empty txHash as a retryable failure (pathological success)", async () => {
    const primarySettle = vi.fn(async (): Promise<SettleResponse> => ({
      settled: true,
      providerId: "coinbase-cdp",
      txHash: "", // empty!
      network: SOLANA_MAINNET,
      amount: "1000",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    } as never));
    const backupSettle = vi.fn(async (): Promise<SettleResponse> => ({
      settled: true,
      providerId: "payai",
      txHash: "RealTxFromBackup",
      network: SOLANA_MAINNET,
      amount: "1000",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    } as never));
    const cdp = fakeRegisteredProvider("coinbase-cdp", primarySettle);
    const payai = fakeRegisteredProvider("payai", backupSettle);
    const registry = fakeRegistry([cdp, payai]);

    const result = await routeSettleWithFailover(svmSettleReq(), {
      registry,
      idempotencyKey: "idem",
    });
    expect(result.adapterUsed).toBe("payai");
    expect(result.response.settled).toBe(true);
    expect(result.failoverFrom.length).toBe(1);
    expect(result.failoverFrom[0]?.errorCode).toBe("broadcast_failed");
  });

  it("converts a thrown ProviderError into a settle response (terminal)", async () => {
    const primarySettle = vi.fn(async (): Promise<SettleResponse> => {
      throw new ProviderError("invalid_authorization", "auth invalid", {
        providerId: "coinbase-cdp",
      });
    });
    const cdp = fakeRegisteredProvider("coinbase-cdp", primarySettle);
    const registry = fakeRegistry([cdp]);

    const result = await routeSettleWithFailover(svmSettleReq(), {
      registry,
      idempotencyKey: "idem",
    });
    expect(result.response.settled).toBe(false);
    expect(result.response.errorCode).toBe("invalid_authorization");
  });

  it("throws route_unsupported when the routing config has no entry for this route", async () => {
    const registry = fakeRegistry([]);
    await expect(
      routeSettleWithFailover(
        {
          paymentPayload: { x402Version: 2, scheme: "exact", network: "eip155:99999", payload: {} },
          paymentRequirements: {
            scheme: "exact",
            network: "eip155:99999",
            maxAmountRequired: "0",
            asset: "x",
            payTo: "x",
            resource: "x",
            maxTimeoutSeconds: 60,
            extra: {},
          },
        } as never,
        { registry, idempotencyKey: "idem" },
      ),
    ).rejects.toMatchObject({ code: "route_unsupported" });
  });
});
