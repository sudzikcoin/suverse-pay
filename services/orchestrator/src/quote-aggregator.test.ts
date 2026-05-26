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
import { describe, expect, it } from "vitest";
import { aggregateQuotes } from "./quote-aggregator.js";
import type { RegisteredProvider } from "./types.js";

function adapterWith(
  id: string,
  fee: string,
  latencyMs: number,
  opts: {
    supports?: (q: SupportQuery) => SupportResult;
    throwOnQuote?: Error;
  } = {},
): ProviderAdapter {
  return {
    id,
    displayName: id,
    async supports(req) {
      return opts.supports ? opts.supports(req) : { supported: true };
    },
    async quote(req: QuoteRequest): Promise<QuoteResponse> {
      if (opts.throwOnQuote) throw opts.throwOnQuote;
      return {
        providerId: id,
        network: req.network,
        asset: req.asset,
        amount: req.amount,
        estimatedFeeUsd: fee,
        estimatedLatencyMs: latencyMs,
        scheme: req.scheme,
        source: "synthetic",
      };
    },
    async verify(_req: VerifyRequest): Promise<VerifyResponse> {
      return { valid: true, providerId: id, verifiedAt: new Date().toISOString() };
    },
    async settle(
      _req: SettleRequest,
      _o?: SettleOptions,
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

function reg(adapter: ProviderAdapter): RegisteredProvider {
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    enabled: true,
    config: {},
    adapter,
  };
}

const REQ: QuoteRequest = {
  network: "cosmos:noble-1",
  asset: "uusdc",
  amount: "10000",
  scheme: "exact_cosmos_authz",
};

describe("aggregateQuotes", () => {
  it("returns empty list and null recommended when no providers", async () => {
    const r = await aggregateQuotes({
      providers: [],
      request: REQ,
      optimize: "cost",
    });
    expect(r.quotes).toEqual([]);
    expect(r.recommended).toBeNull();
  });

  it("orders by lowest fee under optimize=cost", async () => {
    const r = await aggregateQuotes({
      providers: [
        reg(adapterWith("a", "0.005", 100)),
        reg(adapterWith("b", "0.0001", 100)),
        reg(adapterWith("c", "0.001", 100)),
      ],
      request: REQ,
      optimize: "cost",
    });
    expect(r.quotes.map((q) => q.providerId)).toEqual(["b", "c", "a"]);
    expect(r.recommended).toEqual({ providerId: "b", reason: "lowest_cost" });
  });

  it("orders by lowest latency under optimize=latency", async () => {
    const r = await aggregateQuotes({
      providers: [
        reg(adapterWith("a", "0.001", 500)),
        reg(adapterWith("b", "0.001", 200)),
        reg(adapterWith("c", "0.001", 350)),
      ],
      request: REQ,
      optimize: "latency",
    });
    expect(r.quotes.map((q) => q.providerId)).toEqual(["b", "c", "a"]);
    expect(r.recommended).toEqual({
      providerId: "b",
      reason: "lowest_latency",
    });
  });

  it("preserves order under optimize=success_rate (no DB data here)", async () => {
    const r = await aggregateQuotes({
      providers: [
        reg(adapterWith("a", "0.001", 100)),
        reg(adapterWith("b", "0.001", 100)),
      ],
      request: REQ,
      optimize: "success_rate",
    });
    expect(r.quotes.map((q) => q.providerId)).toEqual(["a", "b"]);
    expect(r.recommended?.reason).toBe("first_supported");
  });

  it("drops providers that throw from quote() (Promise.allSettled)", async () => {
    const r = await aggregateQuotes({
      providers: [
        reg(adapterWith("a", "0.005", 100)),
        reg(
          adapterWith("b", "0.0001", 100, {
            throwOnQuote: new Error("provider on fire"),
          }),
        ),
      ],
      request: REQ,
      optimize: "cost",
    });
    expect(r.quotes.map((q) => q.providerId)).toEqual(["a"]);
  });

  it("drops providers that return supported=false", async () => {
    const r = await aggregateQuotes({
      providers: [
        reg(adapterWith("a", "0.005", 100)),
        reg(
          adapterWith("b", "0.0001", 100, {
            supports: () => ({ supported: false }),
          }),
        ),
      ],
      request: REQ,
      optimize: "cost",
    });
    expect(r.quotes.map((q) => q.providerId)).toEqual(["a"]);
  });
});
