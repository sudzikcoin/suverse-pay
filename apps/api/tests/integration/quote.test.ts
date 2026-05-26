import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  TEST_ADMIN_BEARER,
  cleanState,
  setupStack,
  teardownStack,
  type IntegrationStack,
} from "./setup.js";

describe("POST /quote (integration)", () => {
  let stack: IntegrationStack;

  beforeAll(async () => {
    stack = await setupStack();
  });
  afterAll(async () => {
    await teardownStack(stack);
  });
  beforeEach(async () => {
    await cleanState(stack);
  });

  it("returns a synthetic cosmos-pay quote for cosmos:noble-1", async () => {
    const res = await stack.app.inject({
      method: "POST",
      url: "/quote",
      headers: { authorization: TEST_ADMIN_BEARER },
      payload: {
        asset: "uusdc",
        amount: "10000",
        preferredNetworks: ["cosmos:noble-1"],
        scheme: "exact_cosmos_authz",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.quotes.length).toBeGreaterThanOrEqual(1);
    const cosmos = body.quotes.find(
      (q: { providerId: string }) => q.providerId === "cosmos-pay",
    );
    expect(cosmos).toMatchObject({
      providerId: "cosmos-pay",
      network: "cosmos:noble-1",
      asset: "uusdc",
      source: "synthetic",
    });
  });

  it("returns synthetic quotes from both adapters across preferredNetworks", async () => {
    const res = await stack.app.inject({
      method: "POST",
      url: "/quote",
      headers: { authorization: TEST_ADMIN_BEARER },
      payload: {
        asset: "uusdc",
        amount: "10000",
        preferredNetworks: ["cosmos:noble-1", "eip155:8453"],
        scheme: "exact_cosmos_authz",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ids = body.quotes.map((q: { providerId: string }) => q.providerId);
    expect(ids).toContain("cosmos-pay");
  });

  it("optimize=cost orders quotes ascending by estimatedFeeUsd", async () => {
    const res = await stack.app.inject({
      method: "POST",
      url: "/quote",
      headers: { authorization: TEST_ADMIN_BEARER },
      payload: {
        asset: "uusdc",
        amount: "10000",
        preferredNetworks: ["cosmos:noble-1"],
        scheme: "exact_cosmos_authz",
        policy: { optimize: "cost" },
      },
    });
    expect(res.statusCode).toBe(200);
    const quotes = res.json().quotes;
    const fees = quotes.map((q: { estimatedFeeUsd: string }) =>
      Number.parseFloat(q.estimatedFeeUsd),
    );
    for (let i = 1; i < fees.length; i++) {
      expect(fees[i]).toBeGreaterThanOrEqual(fees[i - 1]);
    }
    expect(res.json().recommended.reason).toBe("lowest_cost");
  });
});
