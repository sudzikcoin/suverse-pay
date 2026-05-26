import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  TEST_ADMIN_BEARER,
  cleanState,
  nock,
  nockCosmosVerifyOnce,
  setupStack,
  teardownStack,
  COSMOS_PAY_MOCK_HOST,
  type IntegrationStack,
} from "./setup.js";

function verifyBody() {
  return {
    paymentPayload: {
      x402Version: 2,
      scheme: "exact_cosmos_authz",
      network: "cosmos:noble-1",
      payload: {
        from: "noble1payer",
        publicKey: "k",
        signature: "s",
        authorization: {
          from: "noble1payer",
          to: "noble1recipient",
          denom: "uusdc",
          amount: "10000",
          nonce: "1",
          validAfter: 0,
          validBefore: 9999999999,
          resource: "https://example.com/api/widget",
          chainId: "noble-1",
        },
      },
    },
    paymentRequirements: {
      scheme: "exact_cosmos_authz",
      network: "cosmos:noble-1",
      maxAmountRequired: "10000",
      asset: "uusdc",
      payTo: "noble1recipient",
      resource: "https://example.com/api/widget",
      maxTimeoutSeconds: 60,
      extra: { facilitator: "cosmos-pay.test", chainId: "noble-1" },
    },
  };
}

describe("POST /verify (integration)", () => {
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

  it("forwards verify to the routed adapter and returns valid=true", async () => {
    const scope = nockCosmosVerifyOnce({
      body: { isValid: true, payer: "noble1payer" },
    });
    const res = await stack.app.inject({
      method: "POST",
      url: "/verify",
      headers: { authorization: TEST_ADMIN_BEARER },
      payload: verifyBody(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      valid: true,
      providerId: "cosmos-pay",
      payer: "noble1payer",
    });
    expect(scope.isDone()).toBe(true);
  });

  it("returns 404 route_unsupported when no provider supports the requested scheme", async () => {
    const guard = nock(COSMOS_PAY_MOCK_HOST).post(/.*/).reply(500, "never");
    const body = verifyBody();
    body.paymentRequirements.scheme = "weird_scheme";
    body.paymentPayload.scheme = "weird_scheme";

    const res = await stack.app.inject({
      method: "POST",
      url: "/verify",
      headers: { authorization: TEST_ADMIN_BEARER },
      payload: body,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("route_unsupported");
    expect(guard.isDone()).toBe(false);
    nock.cleanAll();
  });

  it("rejects malformed bodies with 400 invalid_request", async () => {
    const res = await stack.app.inject({
      method: "POST",
      url: "/verify",
      headers: { authorization: TEST_ADMIN_BEARER },
      payload: { paymentPayload: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });
});
