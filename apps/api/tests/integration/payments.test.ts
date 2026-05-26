import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  TEST_ADMIN_BEARER,
  cleanState,
  nockCosmosSettleOnce,
  setupStack,
  teardownStack,
  type IntegrationStack,
} from "./setup.js";

function cosmosSettleBody() {
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

describe("GET /payments/:id (integration)", () => {
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

  it("404 for an unknown payment id", async () => {
    const res = await stack.app.inject({
      method: "GET",
      url: "/payments/pay_does_not_exist",
      headers: { authorization: TEST_ADMIN_BEARER },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("returns the payment + attempts list after a /settle", async () => {
    nockCosmosSettleOnce({
      body: { success: true, transaction: "0xMOCKTX", payer: "noble1payer" },
    });
    const settled = await stack.app.inject({
      method: "POST",
      url: "/settle",
      headers: {
        authorization: TEST_ADMIN_BEARER,
        "idempotency-key": "k-lookup",
      },
      payload: cosmosSettleBody(),
    });
    expect(settled.statusCode).toBe(200);
    const paymentId = settled.json().paymentId;

    const lookup = await stack.app.inject({
      method: "GET",
      url: `/payments/${paymentId}`,
      headers: { authorization: TEST_ADMIN_BEARER },
    });
    expect(lookup.statusCode).toBe(200);
    const body = lookup.json();
    expect(body.paymentId).toBe(paymentId);
    expect(body.status).toBe("settled");
    expect(body.providerId).toBe("cosmos-pay");
    expect(body.txHash).toBe("0xMOCKTX");
    expect(body.attempts).toHaveLength(1);
    expect(body.attempts[0]!.outcome).toBe("success");
    expect(body.attempts[0]!.providerId).toBe("cosmos-pay");
  });
});
