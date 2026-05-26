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

const IDEM_HEADER = { "idempotency-key": "idem-001" };

describe("POST /settle", () => {
  let handles: TestServerHandles | null = null;
  afterEach(async () => {
    await handles?.app.close();
    handles = null;
  });

  it("400 when Idempotency-Key header is missing", async () => {
    const cosmos = makeFakeProvider({ id: "cosmos-pay" });
    handles = await makeTestServer({ providers: [{ fake: cosmos }] });
    const res = await handles.app.inject({
      method: "POST",
      url: "/settle",
      headers: { authorization: TEST_API_KEY_BEARER },
      payload: {
        paymentPayload: paymentPayload(),
        paymentRequirements: paymentRequirements(),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
    // No payment created, no adapter call.
    expect(cosmos.calls.settle).toHaveLength(0);
  });

  it("creates a payment, calls settle, records routing_decisions, finalizes settled", async () => {
    const cosmos = makeFakeProvider({ id: "cosmos-pay" });
    handles = await makeTestServer({ providers: [{ fake: cosmos }] });
    const res = await handles.app.inject({
      method: "POST",
      url: "/settle",
      headers: { authorization: TEST_API_KEY_BEARER, ...IDEM_HEADER },
      payload: {
        paymentPayload: paymentPayload(),
        paymentRequirements: paymentRequirements(),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("settled");
    expect(body.providerId).toBe("cosmos-pay");
    expect(body.attempts).toHaveLength(1);
    expect(body.attempts[0].outcome).toBe("success");
    expect(cosmos.calls.settle).toHaveLength(1);
    expect(handles.ledger.routingDecisions.size).toBe(1);
    expect(handles.ledger.releasedLocks).toHaveLength(1);
  });

  it("returns the existing response on idempotent replay (no second settle call)", async () => {
    const cosmos = makeFakeProvider({ id: "cosmos-pay" });
    handles = await makeTestServer({ providers: [{ fake: cosmos }] });

    const first = await handles.app.inject({
      method: "POST",
      url: "/settle",
      headers: { authorization: TEST_API_KEY_BEARER, ...IDEM_HEADER },
      payload: {
        paymentPayload: paymentPayload(),
        paymentRequirements: paymentRequirements(),
      },
    });
    expect(first.statusCode).toBe(200);
    const firstId = first.json().paymentId;

    const second = await handles.app.inject({
      method: "POST",
      url: "/settle",
      headers: { authorization: TEST_API_KEY_BEARER, ...IDEM_HEADER },
      payload: {
        paymentPayload: paymentPayload(),
        paymentRequirements: paymentRequirements(),
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().paymentId).toBe(firstId);
    expect(cosmos.calls.settle).toHaveLength(1);
  });

  it("falls back to second provider on retryable error from the first", async () => {
    const flaky = makeFakeProvider({
      id: "flaky",
      settle: () => ({
        settled: false,
        providerId: "flaky",
        network: "cosmos:noble-1",
        asset: "uusdc",
        amount: "10000",
        errorCode: "provider_internal_error",
        errorMessage: "boom",
      }),
    });
    const healthy = makeFakeProvider({ id: "healthy" });
    handles = await makeTestServer({
      providers: [{ fake: flaky }, { fake: healthy }],
      healthSummaries: new Map([
        [
          "flaky",
          {
            providerId: "flaky",
            recentAttempts: 0,
            recentFailures: 0,
            lastCheck: null,
            successRate7d: 1,
            avgLatencyMs7d: 100,
            estimatedFeeUsd: "0.0001",
          },
        ],
        [
          "healthy",
          {
            providerId: "healthy",
            recentAttempts: 0,
            recentFailures: 0,
            lastCheck: null,
            successRate7d: 1,
            avgLatencyMs7d: 100,
            estimatedFeeUsd: "0.001",
          },
        ],
      ]),
    });
    const res = await handles.app.inject({
      method: "POST",
      url: "/settle",
      headers: { authorization: TEST_API_KEY_BEARER, ...IDEM_HEADER },
      payload: {
        paymentPayload: paymentPayload(),
        paymentRequirements: paymentRequirements(),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("settled");
    expect(body.providerId).toBe("healthy");
    expect(body.attempts).toHaveLength(2);
    expect(body.attempts[0].providerId).toBe("flaky");
    expect(body.attempts[0].outcome).toBe("failed");
    expect(body.attempts[1].providerId).toBe("healthy");
    expect(body.attempts[1].outcome).toBe("success");
  });

  it("does NOT fall back on non-retryable errors (invalid_signature)", async () => {
    const a = makeFakeProvider({
      id: "a",
      settle: () => ({
        settled: false,
        providerId: "a",
        network: "cosmos:noble-1",
        asset: "uusdc",
        amount: "10000",
        errorCode: "invalid_signature",
        errorMessage: "user-side",
      }),
    });
    const b = makeFakeProvider({ id: "b" });
    handles = await makeTestServer({ providers: [{ fake: a }, { fake: b }] });
    const res = await handles.app.inject({
      method: "POST",
      url: "/settle",
      headers: { authorization: TEST_API_KEY_BEARER, ...IDEM_HEADER },
      payload: {
        paymentPayload: paymentPayload(),
        paymentRequirements: paymentRequirements(),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("failed");
    expect(body.errorCode).toBe("invalid_signature");
    expect(body.attempts).toHaveLength(1);
    expect(b.calls.settle).toHaveLength(0);
  });

  it("finalizes status=failed + errorCode=route_unsupported when no provider supports the route", async () => {
    const cdp = makeFakeProvider({
      id: "coinbase-cdp",
      supports: () => ({ supported: false }),
    });
    handles = await makeTestServer({ providers: [{ fake: cdp }] });
    const res = await handles.app.inject({
      method: "POST",
      url: "/settle",
      headers: { authorization: TEST_API_KEY_BEARER, ...IDEM_HEADER },
      payload: {
        paymentPayload: paymentPayload(),
        paymentRequirements: paymentRequirements(),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("failed");
    expect(body.errorCode).toBe("route_unsupported");
    expect(cdp.calls.settle).toHaveLength(0);
    expect(body.attempts).toHaveLength(0);
  });

  it("releases the Redis lock even on adapter exception", async () => {
    const broken = makeFakeProvider({
      id: "broken",
      settle: () => {
        throw new ProviderError("invalid_authorization", "bad");
      },
    });
    handles = await makeTestServer({ providers: [{ fake: broken }] });
    const res = await handles.app.inject({
      method: "POST",
      url: "/settle",
      headers: { authorization: TEST_API_KEY_BEARER, ...IDEM_HEADER },
      payload: {
        paymentPayload: paymentPayload(),
        paymentRequirements: paymentRequirements(),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("failed");
    expect(handles.ledger.releasedLocks).toHaveLength(1);
  });

  it("forwards Idempotency-Key into SettleOptions on every attempt", async () => {
    const flaky = makeFakeProvider({
      id: "flaky",
      settle: () => ({
        settled: false,
        providerId: "flaky",
        network: "cosmos:noble-1",
        asset: "uusdc",
        amount: "10000",
        errorCode: "network_error",
        errorMessage: "x",
      }),
    });
    const healthy = makeFakeProvider({ id: "healthy" });
    handles = await makeTestServer({
      providers: [{ fake: flaky }, { fake: healthy }],
    });
    await handles.app.inject({
      method: "POST",
      url: "/settle",
      headers: { authorization: TEST_API_KEY_BEARER, ...IDEM_HEADER },
      payload: {
        paymentPayload: paymentPayload(),
        paymentRequirements: paymentRequirements(),
      },
    });
    expect(flaky.calls.settle[0]!.opts?.idempotencyKey).toBe("idem-001");
    expect(healthy.calls.settle[0]!.opts?.idempotencyKey).toBe("idem-001");
  });
});
