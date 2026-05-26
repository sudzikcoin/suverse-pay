import type {
  DiscoveredCapability,
  GetStatusHints,
  HealthStatus,
  ProviderAdapter,
  QuoteRequest,
  QuoteResponse,
  SettleOptions,
  SettleRequest,
  SettleResponse,
  StatusResponse,
  SupportQuery,
  SupportResult,
  VerifyRequest,
  VerifyResponse,
} from "@suverse-pay/core-types";
import { DEFAULT_MERCHANT_POLICY, MerchantPolicySchema } from "@suverse-pay/core-types";
import { describe, expect, it } from "vitest";
import { route } from "./router.js";
import type { ProviderHealthSummary, RegisteredProvider } from "./types.js";

function makeAdapter(
  id: string,
  supports: (q: SupportQuery) => SupportResult,
): ProviderAdapter {
  return {
    id,
    displayName: id,
    async supports(req) {
      return supports(req);
    },
    async quote(req: QuoteRequest): Promise<QuoteResponse> {
      return {
        providerId: id,
        network: req.network,
        asset: req.asset,
        amount: req.amount,
        estimatedFeeUsd: "0.001",
        estimatedLatencyMs: 100,
        scheme: req.scheme,
        source: "synthetic",
      };
    },
    async verify(_req: VerifyRequest): Promise<VerifyResponse> {
      return { valid: true, providerId: id, verifiedAt: new Date().toISOString() };
    },
    async settle(
      _req: SettleRequest,
      _opts?: SettleOptions,
    ): Promise<SettleResponse> {
      return {
        settled: true,
        providerId: id,
        network: "cosmos:noble-1",
        asset: "uusdc",
        amount: "10000",
      };
    },
    async getStatus(_id: string, _h?: GetStatusHints): Promise<StatusResponse> {
      return { providerId: id, providerPaymentId: "x", status: "settled" };
    },
    async healthCheck(): Promise<HealthStatus> {
      return { status: "healthy", checkedAt: new Date().toISOString() };
    },
    async discoverCapabilities(): Promise<DiscoveredCapability[]> {
      return [];
    },
  };
}

function reg(
  id: string,
  supportsFor: ReadonlyArray<{ network: string; asset: string; scheme: string }>,
  opts: { enabled?: boolean; displayName?: string } = {},
): RegisteredProvider {
  return {
    id,
    displayName: opts.displayName ?? id,
    enabled: opts.enabled ?? true,
    config: {},
    adapter: makeAdapter(id, (q) =>
      supportsFor.some(
        (s) => s.network === q.network && s.asset === q.asset && s.scheme === q.scheme,
      )
        ? { supported: true }
        : { supported: false },
    ),
  };
}

const NOW = new Date("2026-05-26T12:00:00Z");

function summary(
  providerId: string,
  overrides: Partial<ProviderHealthSummary> = {},
): ProviderHealthSummary {
  return {
    providerId,
    recentAttempts: 0,
    recentFailures: 0,
    lastCheck: null,
    successRate7d: 1,
    avgLatencyMs7d: 100,
    ...overrides,
  };
}

function ctx(policy = DEFAULT_MERCHANT_POLICY) {
  return {
    network: "cosmos:noble-1" as const,
    asset: "uusdc",
    scheme: "exact_cosmos_authz",
    policy,
  };
}

describe("router — support filter", () => {
  it("excludes providers that don't support the route", async () => {
    const providers = [
      reg("cosmos-pay", [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ]),
      reg("coinbase-cdp", [
        { network: "eip155:8453", asset: "0xUSDC", scheme: "exact" },
      ]),
    ];
    const decision = await route({
      providers,
      context: ctx(),
      healthSummaries: new Map(),
      now: NOW,
    });
    expect(decision.candidates.map((c) => c.providerId)).toEqual(["cosmos-pay"]);
    expect(decision.selected).toBe("cosmos-pay");
  });

  it("excludes disabled providers even if they support the route", async () => {
    const providers = [
      reg(
        "cosmos-pay",
        [{ network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" }],
        { enabled: false },
      ),
    ];
    const decision = await route({
      providers,
      context: ctx(),
      healthSummaries: new Map(),
      now: NOW,
    });
    expect(decision.candidates).toEqual([]);
    expect(decision.selected).toBeNull();
  });

  it("empty selection when no provider supports the route", async () => {
    const providers = [
      reg("coinbase-cdp", [
        { network: "eip155:8453", asset: "0xUSDC", scheme: "exact" },
      ]),
    ];
    const decision = await route({
      providers,
      context: ctx(),
      healthSummaries: new Map(),
      now: NOW,
    });
    expect(decision.candidates).toEqual([]);
    expect(decision.selected).toBeNull();
  });
});

describe("router — health filter (live-traffic rule)", () => {
  it("marks a provider unhealthy when attempts>=10 AND failure ratio>=0.3", async () => {
    const providers = [
      reg("p1", [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ]),
    ];
    const decision = await route({
      providers,
      context: ctx(),
      healthSummaries: new Map([
        ["p1", summary("p1", { recentAttempts: 10, recentFailures: 3 })],
      ]),
      now: NOW,
    });
    expect(decision.candidates).toEqual([]);
  });

  it("keeps a provider healthy when attempts>=10 but failure ratio<0.3", async () => {
    const providers = [
      reg("p1", [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ]),
    ];
    const decision = await route({
      providers,
      context: ctx(),
      healthSummaries: new Map([
        ["p1", summary("p1", { recentAttempts: 100, recentFailures: 29 })],
      ]),
      now: NOW,
    });
    expect(decision.selected).toBe("p1");
  });

  it("rule does NOT fire when recentAttempts < 10 (quiet period)", async () => {
    const providers = [
      reg("p1", [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ]),
    ];
    // 9 attempts with 100% failures should NOT mark unhealthy via this rule.
    const decision = await route({
      providers,
      context: ctx(),
      healthSummaries: new Map([
        ["p1", summary("p1", { recentAttempts: 9, recentFailures: 9 })],
      ]),
      now: NOW,
    });
    expect(decision.selected).toBe("p1");
  });
});

describe("router — health filter (quiet period via provider_health_checks)", () => {
  it("falls back to provider_health_checks last status when low traffic", async () => {
    const providers = [
      reg("p1", [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ]),
    ];
    const decision = await route({
      providers,
      context: ctx(),
      healthSummaries: new Map([
        [
          "p1",
          summary("p1", {
            recentAttempts: 2,
            recentFailures: 0,
            lastCheck: { status: "down", checkedAt: new Date(NOW.getTime() - 30_000) },
          }),
        ],
      ]),
      now: NOW,
    });
    expect(decision.candidates).toEqual([]);
  });

  it("ignores stale provider_health_checks (>5min old)", async () => {
    const providers = [
      reg("p1", [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ]),
    ];
    const decision = await route({
      providers,
      context: ctx(),
      healthSummaries: new Map([
        [
          "p1",
          summary("p1", {
            recentAttempts: 2,
            recentFailures: 0,
            lastCheck: {
              status: "down",
              checkedAt: new Date(NOW.getTime() - 6 * 60_000),
            },
          }),
        ],
      ]),
      now: NOW,
    });
    expect(decision.selected).toBe("p1");
  });

  it("a recent 'healthy' last check keeps the provider in", async () => {
    const providers = [
      reg("p1", [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ]),
    ];
    const decision = await route({
      providers,
      context: ctx(),
      healthSummaries: new Map([
        [
          "p1",
          summary("p1", {
            recentAttempts: 0,
            lastCheck: { status: "healthy", checkedAt: new Date(NOW.getTime() - 10_000) },
          }),
        ],
      ]),
      now: NOW,
    });
    expect(decision.selected).toBe("p1");
  });
});

describe("router — scoring", () => {
  function makeProviders(
    ids: string[],
  ): ReadonlyArray<RegisteredProvider> {
    return ids.map((id) =>
      reg(id, [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ]),
    );
  }

  it("optimize=cost orders providers by lowest estimatedFeeUsd", async () => {
    const decision = await route({
      providers: makeProviders(["a", "b", "c"]),
      context: ctx(MerchantPolicySchema.parse({ optimize: "cost" })),
      healthSummaries: new Map([
        ["a", summary("a", { estimatedFeeUsd: "0.005" })],
        ["b", summary("b", { estimatedFeeUsd: "0.0001" })],
        ["c", summary("c", { estimatedFeeUsd: "0.001" })],
      ]),
      now: NOW,
    });
    expect(decision.candidates.map((c) => c.providerId)).toEqual(["b", "c", "a"]);
  });

  it("optimize=latency orders by avgLatencyMs7d (fallback to estimatedLatencyMs)", async () => {
    const decision = await route({
      providers: makeProviders(["a", "b", "c"]),
      context: ctx(MerchantPolicySchema.parse({ optimize: "latency" })),
      healthSummaries: new Map([
        ["a", summary("a", { avgLatencyMs7d: 500 })],
        ["b", summary("b", { avgLatencyMs7d: 200 })],
        ["c", summary("c", { avgLatencyMs7d: 350 })],
      ]),
      now: NOW,
    });
    expect(decision.candidates.map((c) => c.providerId)).toEqual(["b", "c", "a"]);
  });

  it("optimize=success_rate orders by highest successRate7d", async () => {
    const decision = await route({
      providers: makeProviders(["a", "b", "c"]),
      context: ctx(MerchantPolicySchema.parse({ optimize: "success_rate" })),
      healthSummaries: new Map([
        ["a", summary("a", { successRate7d: 0.9 })],
        ["b", summary("b", { successRate7d: 0.99 })],
        ["c", summary("c", { successRate7d: 0.95 })],
      ]),
      now: NOW,
    });
    expect(decision.candidates.map((c) => c.providerId)).toEqual(["b", "c", "a"]);
  });

  it("provider with no summary scores Infinity (sorted last on cost)", async () => {
    const decision = await route({
      providers: makeProviders(["with-summary", "no-summary"]),
      context: ctx(MerchantPolicySchema.parse({ optimize: "cost" })),
      healthSummaries: new Map([
        ["with-summary", summary("with-summary", { estimatedFeeUsd: "0.01" })],
      ]),
      now: NOW,
    });
    expect(decision.candidates[0]!.providerId).toBe("with-summary");
    expect(decision.candidates[1]!.providerId).toBe("no-summary");
  });
});

describe("router — providerHint", () => {
  function hintCtx(hint: string) {
    return ctx(
      MerchantPolicySchema.parse({ optimize: "cost", providerHint: hint }),
    );
  }

  it("a healthy + supporting hint is promoted to rank 0", async () => {
    const providers = [
      reg("a", [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ]),
      reg("b", [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ]),
    ];
    const decision = await route({
      providers,
      context: hintCtx("b"),
      healthSummaries: new Map([
        ["a", summary("a", { estimatedFeeUsd: "0.0001" })],
        ["b", summary("b", { estimatedFeeUsd: "0.01" })],
      ]),
      now: NOW,
    });
    expect(decision.selected).toBe("b");
    expect(decision.candidates[0]!.reason).toContain("provider_hint");
  });

  it("a hint pointing at an unsupported provider is silently ignored", async () => {
    const providers = [
      reg("a", [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ]),
      reg("b", [{ network: "eip155:8453", asset: "0xUSDC", scheme: "exact" }]),
    ];
    const decision = await route({
      providers,
      context: hintCtx("b"),
      healthSummaries: new Map(),
      now: NOW,
    });
    expect(decision.selected).toBe("a");
  });

  it("a hint pointing at an unhealthy provider is silently ignored", async () => {
    const providers = [
      reg("a", [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ]),
      reg("b", [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ]),
    ];
    const decision = await route({
      providers,
      context: hintCtx("b"),
      healthSummaries: new Map([
        ["a", summary("a", { estimatedFeeUsd: "0.01" })],
        ["b", summary("b", { recentAttempts: 100, recentFailures: 60 })],
      ]),
      now: NOW,
    });
    expect(decision.selected).toBe("a");
    expect(decision.candidates.find((c) => c.providerId === "b")).toBeUndefined();
  });

  it("a hint already at rank 0 is a no-op (no reordering)", async () => {
    const providers = [
      reg("a", [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ]),
      reg("b", [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ]),
    ];
    const decision = await route({
      providers,
      context: hintCtx("a"),
      healthSummaries: new Map([
        ["a", summary("a", { estimatedFeeUsd: "0.0001" })],
        ["b", summary("b", { estimatedFeeUsd: "0.01" })],
      ]),
      now: NOW,
    });
    expect(decision.candidates.map((c) => c.providerId)).toEqual(["a", "b"]);
  });
});

describe("router — edge cases enumerated in the Step 6 brief", () => {
  it("all providers unhealthy → empty selection (no throw)", async () => {
    const providers = [
      reg("a", [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ]),
      reg("b", [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ]),
    ];
    const decision = await route({
      providers,
      context: ctx(),
      healthSummaries: new Map([
        ["a", summary("a", { recentAttempts: 50, recentFailures: 50 })],
        ["b", summary("b", { recentAttempts: 50, recentFailures: 50 })],
      ]),
      now: NOW,
    });
    expect(decision.candidates).toEqual([]);
    expect(decision.selected).toBeNull();
  });

  it("only-provider unhealthy + low traffic + recent healthy check → in", async () => {
    const providers = [
      reg("a", [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ]),
    ];
    const decision = await route({
      providers,
      context: ctx(),
      healthSummaries: new Map([
        [
          "a",
          summary("a", {
            recentAttempts: 5,
            recentFailures: 5,
            lastCheck: { status: "healthy", checkedAt: new Date(NOW.getTime() - 60_000) },
          }),
        ],
      ]),
      now: NOW,
    });
    expect(decision.selected).toBe("a");
  });

  it("only-provider unhealthy + high traffic + 30% failures → fallback empty", async () => {
    const providers = [
      reg("a", [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ]),
    ];
    const decision = await route({
      providers,
      context: ctx(),
      healthSummaries: new Map([
        [
          "a",
          summary("a", {
            recentAttempts: 100,
            recentFailures: 30,
            lastCheck: { status: "healthy", checkedAt: new Date(NOW.getTime() - 1_000) },
          }),
        ],
      ]),
      now: NOW,
    });
    expect(decision.candidates).toEqual([]);
  });

  it("RoutingDecision carries decidedAt + policyUsed for the audit row", async () => {
    const providers = [
      reg("a", [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ]),
    ];
    const decision = await route({
      providers,
      context: ctx(),
      healthSummaries: new Map(),
      now: NOW,
    });
    expect(decision.decidedAt).toEqual(NOW);
    expect(decision.policyUsed.optimize).toBe("cost");
  });
});
