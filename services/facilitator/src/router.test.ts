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
const BASE_MAINNET = "eip155:8453";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// EIP-3009 EVM SettleRequest. Used by the EVM failover test below
// — proves the multi-adapter routing works on EVM payloads, not just
// Solana. Sub-task 7 of Phase 3 already proved Cosmos via cosmos-pay;
// Sub-task 2 of Phase 4 Block 1 adds the EVM half.
function evmSettleReq(): SettleRequest {
  return {
    paymentPayload: {
      x402Version: 2,
      scheme: "exact",
      network: BASE_MAINNET,
      payload: {
        signature: "0x" + "ab".repeat(65),
        authorization: {
          from: "0xA2F8a871AfDC463aaEf5FAe8284d900f4d02538E",
          to:   "0x000000000000000000000000000000000000bEEF",
          value: "1000",
          validAfter:  "0",
          validBefore: "9999999999",
          nonce: "0x" + "11".repeat(32),
        },
      },
    },
    paymentRequirements: {
      scheme: "exact",
      network: BASE_MAINNET,
      maxAmountRequired: "1000",
      asset: BASE_USDC,
      payTo: "0x000000000000000000000000000000000000bEEF",
      resource: "https://example.com/x",
      maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2", decimals: 6, symbol: "USDC" },
    },
  } as never;
}

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
  // Lock in EVM routes so a config refactor can't silently drop them.

  // (a) CDP-primary EVM networks. For overlap networks PayAI is the
  // expected failover (index 1) — also asserted below.
  const cdpPrimaryRoutes = [
    "eip155:8453:exact",   // Base mainnet
    "eip155:137:exact",    // Polygon
    "eip155:42161:exact",  // Arbitrum
    "eip155:84532:exact",  // Base Sepolia (v0.3.1)
    "eip155:480:exact",    // World Chain mainnet (v0.3.2)
    "eip155:4801:exact",   // World Sepolia (v0.3.2)
  ];
  for (const key of cdpPrimaryRoutes) {
    it(`routes ${key} primary to coinbase-cdp`, async () => {
      const { getRoutingPriority } = await import("./routing-config.js");
      const network = key.replace(":exact", "");
      const priority = getRoutingPriority(network, "exact");
      expect(priority?.[0]).toBe("coinbase-cdp");
    });
  }

  // (b) Networks where PayAI is registered as failover. Added in
  // Phase 4 Block 1 Sub-task 2.
  const cdpPlusPayaiRoutes = [
    "eip155:8453:exact",
    "eip155:137:exact",
    "eip155:42161:exact",
    "eip155:84532:exact",
  ];
  for (const key of cdpPlusPayaiRoutes) {
    it(`routes ${key} with payai as failover`, async () => {
      const { getRoutingPriority } = await import("./routing-config.js");
      const network = key.replace(":exact", "");
      const priority = getRoutingPriority(network, "exact");
      expect(priority).toEqual(["coinbase-cdp", "payai"]);
    });
  }

  // (c) World Chain routes must NOT advertise PayAI failover (PayAI
  // /supported doesn't list eip155:480 / 4801) — would otherwise
  // surface as 500s when PayAI rejects with route_unsupported.
  for (const key of ["eip155:480:exact", "eip155:4801:exact"]) {
    it(`route ${key} does NOT failover to payai (PayAI lacks the network)`, async () => {
      const { getRoutingPriority } = await import("./routing-config.js");
      const network = key.replace(":exact", "");
      const priority = getRoutingPriority(network, "exact");
      expect(priority).toEqual(["coinbase-cdp"]);
    });
  }

  // (d) PayAI-primary + Thirdweb-failover routes. Phase 4 Block 1
  // Sub-task 2 launched these PayAI-only; Phase 4 Block 2 Sub-task 5
  // added Thirdweb as a secondary because Thirdweb's /supported lists
  // the same USDC contracts for these three networks. Routing keeps
  // PayAI primary (Sub-task 2 already smoke-tested that path).
  const payaiPlusThirdwebRoutes = [
    "eip155:43114:exact",  // Avalanche C-Chain mainnet
    "eip155:43113:exact",  // Avalanche Fuji
    "eip155:421614:exact", // Arbitrum Sepolia
  ];
  for (const key of payaiPlusThirdwebRoutes) {
    it(`routes ${key} with payai primary + thirdweb failover`, async () => {
      const { getRoutingPriority } = await import("./routing-config.js");
      const network = key.replace(":exact", "");
      const priority = getRoutingPriority(network, "exact");
      expect(priority).toEqual(["payai", "thirdweb-x402"]);
    });
  }

  // (f) BNB Chain — Phase 4 Block 2 Sub-task 7 launched Binance-only;
  // Sub-task 8 added BofAI as failover because BofAI's /supported also
  // advertises eip155:56 with the same USDC + USDT contracts. Plus
  // exact_permit on BSC (mainnet + testnet) routes to BofAI alone
  // (Binance hasn't confirmed permit support on their surface yet).
  it("routes eip155:56:exact binance primary + bofai failover", async () => {
    const { getRoutingPriority } = await import("./routing-config.js");
    expect(getRoutingPriority("eip155:56", "exact")).toEqual([
      "binance-x402",
      "bofai-x402",
    ]);
  });
  it("routes eip155:56:exact_permit bofai-only (Binance hasn't advertised permit)", async () => {
    const { getRoutingPriority } = await import("./routing-config.js");
    expect(getRoutingPriority("eip155:56", "exact_permit")).toEqual([
      "bofai-x402",
    ]);
  });
  it("routes eip155:97:exact bofai-only (BSC testnet via BofAI)", async () => {
    const { getRoutingPriority } = await import("./routing-config.js");
    expect(getRoutingPriority("eip155:97", "exact")).toEqual(["bofai-x402"]);
  });

  // (h) Cosmos noble-1 MAINNET — Phase 4 Block 2 Sub-task 10. First
  // Cosmos mainnet route in the gateway (cosmos-pay covers testnet
  // grand-1 only). t402-io advertises noble-1 with native USDT under
  // `exact-direct` (direct ERC-20-style transfer, NOT plain `exact`
  // and NOT cosmos-pay's `exact_cosmos_authz`).
  it("routes cosmos:noble-1:exact-direct to t402-io (first Cosmos mainnet route)", async () => {
    const { getRoutingPriority } = await import("./routing-config.js");
    expect(getRoutingPriority("cosmos:noble-1", "exact-direct")).toEqual([
      "t402-io",
    ]);
  });

  // (g) TRON — Phase 4 Block 2 Sub-task 8. First non-EVM, non-Solana,
  // non-Cosmos route in the gateway. BofAI is the only adapter today;
  // signer-tron arrives in Phase 5.
  const tronRoutes = [
    "tron:mainnet:exact",
    "tron:mainnet:exact_permit",
    "tron:mainnet:exact_gasfree",
    "tron:nile:exact",
    "tron:nile:exact_permit",
    "tron:nile:exact_gasfree",
  ];
  for (const key of tronRoutes) {
    it(`routes ${key} bofai-only (TRON namespace, single adapter)`, async () => {
      const { getRoutingPriority } = await import("./routing-config.js");
      const [namespace, ref, scheme] = key.split(":");
      const network = `${namespace}:${ref}`;
      const priority = getRoutingPriority(network, scheme!);
      expect(priority).toEqual(["bofai-x402"]);
    });
  }

  // (e) Thirdweb-exclusive EVM routes (Phase 4 Block 1 Sub-task 3 +
  // Block 2 Sub-task 5). Networks where CDP and PayAI advertise nothing
  // on x402 — Thirdweb's Nexus facilitator is the only path. Sub-task 5
  // expanded this from 2 to 11 networks.
  const thirdwebOnlyEvmRoutes = [
    "eip155:1:exact",     // Ethereum mainnet      (Sub-task 3)
    "eip155:10:exact",    // Optimism mainnet      (Sub-task 3)
    "eip155:50:exact",    // XDC                    (Sub-task 5)
    "eip155:143:exact",   // Monad mainnet          (Sub-task 5)
    "eip155:146:exact",   // Sonic                  (Sub-task 5)
    "eip155:1329:exact",  // Sei mainnet            (Sub-task 5)
    "eip155:2741:exact",  // Abstract               (Sub-task 5)
    "eip155:4689:exact",  // IoTeX                  (Sub-task 5)
    "eip155:42220:exact", // Celo                   (Sub-task 5)
    "eip155:57073:exact", // Ink                    (Sub-task 5)
    "eip155:59144:exact", // Linea                  (Sub-task 5)
  ];
  for (const key of thirdwebOnlyEvmRoutes) {
    it(`routes ${key} thirdweb-only (CDP + PayAI don't advertise)`, async () => {
      const { getRoutingPriority } = await import("./routing-config.js");
      const network = key.replace(":exact", "");
      const priority = getRoutingPriority(network, "exact");
      expect(priority).toEqual(["thirdweb-x402"]);
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

  it("EVM: falls over from coinbase-cdp to payai on a retryable error AND reuses the idempotency key", async () => {
    // Phase 4 Block 1 Sub-task 2 — proves multi-adapter EVM routing
    // works end-to-end. CDP returns a retryable failure on a Base
    // mainnet EVM settle; the router transparently retries against
    // PayAI with the SAME idempotency key.
    const cdpSettle = vi.fn(async (): Promise<SettleResponse> => ({
      settled: false,
      providerId: "coinbase-cdp",
      network: BASE_MAINNET,
      amount: "1000",
      asset: BASE_USDC,
      errorCode: "temporary_unavailable",
      errorMessage: "CDP 503 rate-limited",
    } as never));
    const payaiSettle = vi.fn(async (): Promise<SettleResponse> => ({
      settled: true,
      providerId: "payai",
      txHash: "0xpayai-evm-tx-hash",
      network: BASE_MAINNET,
      amount: "1000",
      asset: BASE_USDC,
    } as never));
    const cdp = fakeRegisteredProvider("coinbase-cdp", cdpSettle);
    const payai = fakeRegisteredProvider("payai", payaiSettle);
    const registry = fakeRegistry([cdp, payai]);

    const result = await routeSettleWithFailover(evmSettleReq(), {
      registry,
      idempotencyKey: "evm-failover-key",
    });
    expect(result.adapterUsed).toBe("payai");
    expect(result.failoverFrom).toEqual([
      {
        adapterId: "coinbase-cdp",
        errorCode: "temporary_unavailable",
        errorMessage: "CDP 503 rate-limited",
      },
    ]);
    expect(result.response.settled).toBe(true);
    // Same idempotency key on both attempts so adapters that respect
    // it don't double-broadcast.
    expect(cdpSettle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: "evm-failover-key" }),
    );
    expect(payaiSettle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: "evm-failover-key" }),
    );
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
