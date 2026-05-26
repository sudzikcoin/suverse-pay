import { afterEach, describe, expect, it } from "vitest";
import {
  TEST_API_KEY_BEARER,
  makeFakeProvider,
  makeTestServer,
  paymentPayload,
  paymentRequirements,
  type TestServerHandles,
} from "./helpers.js";

describe("GET /payments/:id", () => {
  let handles: TestServerHandles | null = null;
  afterEach(async () => {
    await handles?.app.close();
    handles = null;
  });

  it("returns 404 not_found for an unknown payment id", async () => {
    handles = await makeTestServer({});
    const res = await handles.app.inject({
      method: "GET",
      url: "/payments/pay_does_not_exist",
      headers: { authorization: TEST_API_KEY_BEARER },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("returns the payment row + attempts after a /settle", async () => {
    const cosmos = makeFakeProvider({ id: "cosmos-pay" });
    handles = await makeTestServer({ providers: [{ fake: cosmos }] });
    const settleRes = await handles.app.inject({
      method: "POST",
      url: "/settle",
      headers: {
        authorization: TEST_API_KEY_BEARER,
        "idempotency-key": "k1",
      },
      payload: {
        paymentPayload: paymentPayload(),
        paymentRequirements: paymentRequirements(),
      },
    });
    const paymentId = settleRes.json().paymentId;

    const lookup = await handles.app.inject({
      method: "GET",
      url: `/payments/${paymentId}`,
      headers: { authorization: TEST_API_KEY_BEARER },
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({
      paymentId,
      status: "settled",
      providerId: "cosmos-pay",
    });
  });

  it("returns 404 (not 403) for another tenant's payment — no existence leak", async () => {
    // Seed a payment for a fictitious other api_key id by manipulating
    // the fake ledger directly.
    handles = await makeTestServer({});
    const otherPaymentId = "pay_other";
    handles.ledger.payments.set(otherPaymentId, {
      paymentId: otherPaymentId,
      apiKeyId: "apikey_someone_else",
      status: "settled",
      network: "cosmos:noble-1",
      asset: "uusdc",
      amount: "1",
      recipient: "noble1z",
      createdAt: new Date("2026-05-26T12:00:00Z"),
    });
    const res = await handles.app.inject({
      method: "GET",
      url: `/payments/${otherPaymentId}`,
      headers: { authorization: TEST_API_KEY_BEARER },
    });
    expect(res.statusCode).toBe(404);
  });
});
