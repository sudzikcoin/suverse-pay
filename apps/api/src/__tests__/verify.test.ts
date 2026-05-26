import { ProviderError } from "@suverse-pay/core-types";
import { afterEach, describe, expect, it } from "vitest";
import {
  TEST_API_KEY_BEARER,
  makeFakeProvider,
  makeTestServer,
  paymentPayload,
  paymentRequirements,
  type TestServerHandles,
} from "./helpers.js";

describe("POST /verify", () => {
  let handles: TestServerHandles | null = null;
  afterEach(async () => {
    await handles?.app.close();
    handles = null;
  });

  it("rejects bodies failing Zod validation", async () => {
    handles = await makeTestServer({});
    const res = await handles.app.inject({
      method: "POST",
      url: "/verify",
      headers: { authorization: TEST_API_KEY_BEARER },
      payload: { paymentPayload: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("routes to the supporting provider and forwards verify()", async () => {
    const cosmos = makeFakeProvider({
      id: "cosmos-pay",
      verify: () => ({
        valid: true,
        providerId: "cosmos-pay",
        verifiedAt: "2026-05-26T12:00:00.000Z",
        payer: "noble1xyz",
      }),
    });
    handles = await makeTestServer({ providers: [{ fake: cosmos }] });
    const res = await handles.app.inject({
      method: "POST",
      url: "/verify",
      headers: { authorization: TEST_API_KEY_BEARER },
      payload: {
        paymentPayload: paymentPayload(),
        paymentRequirements: paymentRequirements(),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      valid: true,
      providerId: "cosmos-pay",
      payer: "noble1xyz",
    });
    expect(cosmos.calls.verify).toHaveLength(1);
  });

  it("returns 404 route_unsupported when no provider supports the route", async () => {
    const cdp = makeFakeProvider({
      id: "coinbase-cdp",
      supports: () => ({ supported: false }),
    });
    handles = await makeTestServer({ providers: [{ fake: cdp }] });
    const res = await handles.app.inject({
      method: "POST",
      url: "/verify",
      headers: { authorization: TEST_API_KEY_BEARER },
      payload: {
        paymentPayload: paymentPayload(),
        paymentRequirements: paymentRequirements(),
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("route_unsupported");
  });

  it("respects providerHint when the hinted provider passes filters", async () => {
    const fastButPricy = makeFakeProvider({ id: "fast", displayName: "Fast" });
    const cheapDefault = makeFakeProvider({
      id: "cheap",
      displayName: "Cheap",
    });
    handles = await makeTestServer({
      providers: [{ fake: fastButPricy }, { fake: cheapDefault }],
      healthSummaries: new Map([
        [
          "fast",
          {
            providerId: "fast",
            recentAttempts: 0,
            recentFailures: 0,
            lastCheck: null,
            successRate7d: 1,
            avgLatencyMs7d: 100,
            estimatedFeeUsd: "0.005",
          },
        ],
        [
          "cheap",
          {
            providerId: "cheap",
            recentAttempts: 0,
            recentFailures: 0,
            lastCheck: null,
            successRate7d: 1,
            avgLatencyMs7d: 200,
            estimatedFeeUsd: "0.0001",
          },
        ],
      ]),
    });
    const res = await handles.app.inject({
      method: "POST",
      url: "/verify",
      headers: { authorization: TEST_API_KEY_BEARER },
      payload: {
        paymentPayload: paymentPayload(),
        paymentRequirements: paymentRequirements(),
        providerHint: "fast",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().providerId).toBe("fast");
    expect(fastButPricy.calls.verify).toHaveLength(1);
    expect(cheapDefault.calls.verify).toHaveLength(0);
  });

  it("surfaces a ProviderError thrown by adapter.verify as 502", async () => {
    const cosmos = makeFakeProvider({
      id: "cosmos-pay",
      verify: () => {
        throw new ProviderError("provider_internal_error", "boom");
      },
    });
    handles = await makeTestServer({ providers: [{ fake: cosmos }] });
    const res = await handles.app.inject({
      method: "POST",
      url: "/verify",
      headers: { authorization: TEST_API_KEY_BEARER },
      payload: {
        paymentPayload: paymentPayload(),
        paymentRequirements: paymentRequirements(),
      },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("provider_internal_error");
  });
});
