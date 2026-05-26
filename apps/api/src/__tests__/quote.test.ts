import { afterEach, describe, expect, it } from "vitest";
import {
  TEST_API_KEY_BEARER,
  makeFakeProvider,
  makeTestServer,
  type TestServerHandles,
} from "./helpers.js";

describe("POST /quote", () => {
  let handles: TestServerHandles | null = null;
  afterEach(async () => {
    await handles?.app.close();
    handles = null;
  });

  it("rejects bodies failing Zod validation with 400 invalid_request", async () => {
    handles = await makeTestServer({});
    const res = await handles.app.inject({
      method: "POST",
      url: "/quote",
      headers: { authorization: TEST_API_KEY_BEARER },
      payload: { /* empty */ },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("returns empty quotes when no provider supports the route", async () => {
    const cdp = makeFakeProvider({
      id: "coinbase-cdp",
      supports: () => ({ supported: false }),
    });
    handles = await makeTestServer({ providers: [{ fake: cdp }] });
    const res = await handles.app.inject({
      method: "POST",
      url: "/quote",
      headers: { authorization: TEST_API_KEY_BEARER },
      payload: {
        asset: "USDC",
        amount: "10000",
        preferredNetworks: ["eip155:8453"],
        scheme: "exact",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ quotes: [], recommended: null });
  });

  it("orders quotes by cost when optimize=cost (lowest first)", async () => {
    const expensive = makeFakeProvider({
      id: "expensive",
      quote: (req) => ({
        providerId: "expensive",
        network: req.network,
        asset: req.asset,
        amount: req.amount,
        estimatedFeeUsd: "0.005",
        estimatedLatencyMs: 100,
        scheme: req.scheme,
        source: "synthetic",
      }),
    });
    const cheap = makeFakeProvider({
      id: "cheap",
      quote: (req) => ({
        providerId: "cheap",
        network: req.network,
        asset: req.asset,
        amount: req.amount,
        estimatedFeeUsd: "0.0001",
        estimatedLatencyMs: 500,
        scheme: req.scheme,
        source: "synthetic",
      }),
    });
    handles = await makeTestServer({
      providers: [{ fake: expensive }, { fake: cheap }],
    });
    const res = await handles.app.inject({
      method: "POST",
      url: "/quote",
      headers: { authorization: TEST_API_KEY_BEARER },
      payload: {
        asset: "uusdc",
        amount: "10000",
        preferredNetworks: ["cosmos:noble-1"],
        scheme: "exact_cosmos_authz",
        policy: { optimize: "cost" },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.quotes.map((q: { providerId: string }) => q.providerId)).toEqual([
      "cheap",
      "expensive",
    ]);
    expect(body.recommended.providerId).toBe("cheap");
    expect(body.recommended.reason).toBe("lowest_cost");
  });

  it("orders quotes by latency when optimize=latency", async () => {
    const slow = makeFakeProvider({
      id: "slow",
      quote: (req) => ({
        providerId: "slow",
        network: req.network,
        asset: req.asset,
        amount: req.amount,
        estimatedFeeUsd: "0.001",
        estimatedLatencyMs: 800,
        scheme: req.scheme,
        source: "synthetic",
      }),
    });
    const fast = makeFakeProvider({
      id: "fast",
      quote: (req) => ({
        providerId: "fast",
        network: req.network,
        asset: req.asset,
        amount: req.amount,
        estimatedFeeUsd: "0.001",
        estimatedLatencyMs: 100,
        scheme: req.scheme,
        source: "synthetic",
      }),
    });
    handles = await makeTestServer({
      providers: [{ fake: slow }, { fake: fast }],
    });
    const res = await handles.app.inject({
      method: "POST",
      url: "/quote",
      headers: { authorization: TEST_API_KEY_BEARER },
      payload: {
        asset: "uusdc",
        amount: "10000",
        preferredNetworks: ["cosmos:noble-1"],
        scheme: "exact_cosmos_authz",
        policy: { optimize: "latency" },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(
      res.json().quotes.map((q: { providerId: string }) => q.providerId),
    ).toEqual(["fast", "slow"]);
    expect(res.json().recommended.reason).toBe("lowest_latency");
  });

  it("merges quotes from multiple preferredNetworks", async () => {
    const cosmos = makeFakeProvider({
      id: "cosmos-pay",
      supports: (q) =>
        q.network === "cosmos:noble-1"
          ? { supported: true }
          : { supported: false },
      quote: (req) => ({
        providerId: "cosmos-pay",
        network: req.network,
        asset: req.asset,
        amount: req.amount,
        estimatedFeeUsd: "0.0001",
        estimatedLatencyMs: 300,
        scheme: req.scheme,
        source: "synthetic",
      }),
    });
    const cdp = makeFakeProvider({
      id: "coinbase-cdp",
      supports: (q) =>
        q.network === "eip155:8453"
          ? { supported: true }
          : { supported: false },
      quote: (req) => ({
        providerId: "coinbase-cdp",
        network: req.network,
        asset: req.asset,
        amount: req.amount,
        estimatedFeeUsd: "0.001",
        estimatedLatencyMs: 100,
        scheme: req.scheme,
        source: "synthetic",
      }),
    });
    handles = await makeTestServer({
      providers: [{ fake: cosmos }, { fake: cdp }],
    });
    const res = await handles.app.inject({
      method: "POST",
      url: "/quote",
      headers: { authorization: TEST_API_KEY_BEARER },
      payload: {
        asset: "USDC",
        amount: "10000",
        preferredNetworks: ["cosmos:noble-1", "eip155:8453"],
        scheme: "exact_cosmos_authz",
        policy: { optimize: "cost" },
      },
    });
    // cdp doesn't support exact_cosmos_authz scheme query at the
    // first network either, but supports() is per-(network,asset,scheme)
    // and our fake gates on network only — so it ends up in the result
    // for the eip155 leg only.
    expect(res.statusCode).toBe(200);
    const ids = res.json().quotes.map((q: { providerId: string }) => q.providerId);
    expect(ids).toContain("cosmos-pay");
  });
});
