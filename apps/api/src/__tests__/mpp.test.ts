import {
  credentialToHeaderLine,
  type MppCapability,
  type MppChallenge,
  type MppCredential,
  type MppFacilitatorAdapter,
  type MppSettleResult,
  type MppVerifyResult,
} from "@suverse-pay/adapter-mpp";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestServer, TEST_API_KEY_BEARER, type TestServerHandles } from "./helpers.js";

const PAYER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const PATHUSD = "0x20c0000000000000000000000000000000000000";
const TX_HASH =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const IDEM_KEY = "idem-mpp-001";

function authHeaders(opts: { idempotencyKey?: string; payment?: string } = {}) {
  const out: Record<string, string> = {
    authorization: TEST_API_KEY_BEARER,
  };
  if (opts.idempotencyKey !== undefined) {
    out["idempotency-key"] = opts.idempotencyKey;
  }
  if (opts.payment !== undefined) {
    out["payment-authorization"] = opts.payment;
  }
  return out;
}

function chargeBody(overrides: Record<string, unknown> = {}) {
  return {
    amount: "1000000",
    currency: PATHUSD,
    recipient: RECIPIENT,
    chainId: 42431,
    ...overrides,
  };
}

interface FakeMppAdapterCalls {
  verify: Array<{ challenge: MppChallenge; credential: MppCredential }>;
  settle: Array<{ challenge: MppChallenge; credential: MppCredential; idempotencyKey?: string }>;
}

function makeFakeMppAdapter(opts: {
  verify?: (args: {
    challenge: MppChallenge;
    credential: MppCredential;
  }) => MppVerifyResult | Promise<MppVerifyResult>;
  settle?: (args: {
    challenge: MppChallenge;
    credential: MppCredential;
    idempotencyKey?: string;
  }) => MppSettleResult | Promise<MppSettleResult>;
  capabilities?: ReadonlyArray<MppCapability>;
}): { adapter: MppFacilitatorAdapter; calls: FakeMppAdapterCalls } {
  const calls: FakeMppAdapterCalls = { verify: [], settle: [] };
  const adapter: MppFacilitatorAdapter = {
    id: "mpp",
    displayName: "Machine Payments Protocol",
    getCapabilities: () => opts.capabilities ?? [],
    async verifyCredential(args) {
      calls.verify.push(args);
      return (
        (await opts.verify?.(args)) ?? {
          valid: true,
          verifiedAt: "2026-05-31T00:00:00Z",
          payer: PAYER,
        }
      );
    },
    async settleCredential(args) {
      calls.settle.push(args);
      return (
        (await opts.settle?.(args)) ?? {
          settled: true,
          reference: TX_HASH,
          amount: "1000000",
          asset: PATHUSD,
          network: "eip155:42431",
          settledAt: "2026-05-31T00:00:00Z",
        }
      );
    },
    async getHealthStatus() {
      return { status: "healthy", checkedAt: "2026-05-31T00:00:00Z" };
    },
  };
  return { adapter, calls };
}

const HASH_CRED: MppCredential = {
  challengeId: IDEM_KEY,
  method: "tempo",
  intent: "charge",
  payload: { type: "hash", hash: TX_HASH },
};

describe("POST /mpp/charge", () => {
  let handles: TestServerHandles | null = null;
  afterEach(async () => {
    await handles?.app.close();
    handles = null;
  });

  it("503 when MPP adapter is not configured", async () => {
    handles = await makeTestServer({});
    const res = await handles.app.inject({
      method: "POST",
      url: "/mpp/charge",
      headers: authHeaders({ idempotencyKey: IDEM_KEY }),
      payload: chargeBody(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("temporary_unavailable");
  });

  it("400 when Idempotency-Key header is missing", async () => {
    handles = await makeTestServer({});
    const { adapter } = makeFakeMppAdapter({});
    handles.ctx.mppAdapter = adapter;
    const res = await handles.app.inject({
      method: "POST",
      url: "/mpp/charge",
      headers: authHeaders(),
      payload: chargeBody(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("401 when gateway Bearer auth is missing", async () => {
    handles = await makeTestServer({});
    const { adapter } = makeFakeMppAdapter({});
    handles.ctx.mppAdapter = adapter;
    const res = await handles.app.inject({
      method: "POST",
      url: "/mpp/charge",
      headers: { "idempotency-key": IDEM_KEY },
      payload: chargeBody(),
    });
    expect(res.statusCode).toBe(401);
  });

  it("first call (no Payment-Authorization) returns 402 + WWW-Authenticate + JSON challenge", async () => {
    handles = await makeTestServer({});
    const { adapter, calls } = makeFakeMppAdapter({});
    handles.ctx.mppAdapter = adapter;
    const res = await handles.app.inject({
      method: "POST",
      url: "/mpp/charge",
      headers: authHeaders({ idempotencyKey: IDEM_KEY }),
      payload: chargeBody(),
    });
    expect(res.statusCode).toBe(402);
    const wwwAuth = res.headers["www-authenticate"];
    expect(typeof wwwAuth).toBe("string");
    expect(String(wwwAuth).startsWith("Payment ")).toBe(true);
    const body = res.json();
    expect(body.error).toBe("payment_required");
    expect(body.challenge.id).toBe(IDEM_KEY);
    expect(body.challenge.method).toBe("tempo");
    expect(body.challenge.intent).toBe("charge");
    expect(body.challenge.request.amount).toBe("1000000");
    expect(body.challenge.request.chainId).toBe(42431);
    expect(body.challenge.request.recipient).toBe(RECIPIENT);
    expect(calls.verify).toHaveLength(0);
    expect(calls.settle).toHaveLength(0);
  });

  it("retry with valid credential drives verify + settle + persists payment with protocol=mpp", async () => {
    handles = await makeTestServer({});
    const { adapter, calls } = makeFakeMppAdapter({});
    handles.ctx.mppAdapter = adapter;
    const res = await handles.app.inject({
      method: "POST",
      url: "/mpp/charge",
      headers: authHeaders({
        idempotencyKey: IDEM_KEY,
        payment: credentialToHeaderLine(HASH_CRED),
      }),
      payload: chargeBody(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.reference).toBe(TX_HASH);
    expect(body.network).toBe("eip155:42431");
    expect(body.payer).toBe(PAYER);
    expect(body.amount).toBe("1000000");
    // Adapter called once each.
    expect(calls.verify).toHaveLength(1);
    expect(calls.settle).toHaveLength(1);
    expect(calls.verify[0]?.credential.payload).toMatchObject({
      type: "hash",
      hash: TX_HASH,
    });
    // Payment-Response header emitted on success.
    const paymentResp = res.headers["payment-response"];
    expect(typeof paymentResp).toBe("string");
    expect(JSON.parse(String(paymentResp))).toMatchObject({
      protocol: "mpp",
      reference: TX_HASH,
    });
    // Ledger row persisted with protocol=mpp + mppMethod + mppIntent.
    const ledgerRow = Array.from(handles.ledger.payments.values())[0];
    expect(ledgerRow).toBeDefined();
    expect(ledgerRow?.status).toBe("settled");
    expect(ledgerRow?.network).toBe("eip155:42431");
    expect(ledgerRow?.protocol).toBe("mpp");
    expect(ledgerRow?.mppMethod).toBe("tempo");
    expect(ledgerRow?.mppIntent).toBe("charge");
  });

  it("422 when adapter verifyCredential returns valid=false (e.g. transaction_not_found)", async () => {
    handles = await makeTestServer({});
    const { adapter } = makeFakeMppAdapter({
      verify: () => ({
        valid: false,
        verifiedAt: "2026-05-31T00:00:00Z",
        errorCode: "transaction_not_found",
        errorMessage: "Receipt for tx not present on Tempo Moderato.",
      }),
    });
    handles.ctx.mppAdapter = adapter;
    const res = await handles.app.inject({
      method: "POST",
      url: "/mpp/charge",
      headers: authHeaders({
        idempotencyKey: IDEM_KEY,
        payment: credentialToHeaderLine(HASH_CRED),
      }),
      payload: chargeBody(),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("transaction_not_found");
    // No ledger row created when verify fails.
    expect(handles.ledger.payments.size).toBe(0);
  });

  it("422 when verify passes but settle fails (e.g. transfer_not_found)", async () => {
    handles = await makeTestServer({});
    const { adapter } = makeFakeMppAdapter({
      settle: () => ({
        settled: false,
        settledAt: "2026-05-31T00:00:00Z",
        errorCode: "transfer_not_found",
        errorMessage: "No matching Transfer log in receipt.",
      }),
    });
    handles.ctx.mppAdapter = adapter;
    const res = await handles.app.inject({
      method: "POST",
      url: "/mpp/charge",
      headers: authHeaders({
        idempotencyKey: IDEM_KEY,
        payment: credentialToHeaderLine(HASH_CRED),
      }),
      payload: chargeBody(),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("transfer_not_found");
    expect(handles.ledger.payments.size).toBe(0);
  });

  it("400 when MPP credential.challengeId does not match Idempotency-Key", async () => {
    handles = await makeTestServer({});
    const { adapter } = makeFakeMppAdapter({});
    handles.ctx.mppAdapter = adapter;
    const wrongIdCred: MppCredential = {
      ...HASH_CRED,
      challengeId: "wrong-id",
    };
    const res = await handles.app.inject({
      method: "POST",
      url: "/mpp/charge",
      headers: authHeaders({
        idempotencyKey: IDEM_KEY,
        payment: credentialToHeaderLine(wrongIdCred),
      }),
      payload: chargeBody(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
    expect(String(res.json().error.message)).toContain("challengeId");
  });

  it("400 when Payment-Authorization header is malformed (not base64url JSON)", async () => {
    handles = await makeTestServer({});
    const { adapter } = makeFakeMppAdapter({});
    handles.ctx.mppAdapter = adapter;
    const res = await handles.app.inject({
      method: "POST",
      url: "/mpp/charge",
      headers: authHeaders({
        idempotencyKey: IDEM_KEY,
        payment: "Payment garbage!!",
      }),
      payload: chargeBody(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
    expect(String(res.json().error.message)).toContain("Malformed");
  });

  it("idempotency replay: second retry with same key returns the persisted payment without re-settling", async () => {
    handles = await makeTestServer({});
    const { adapter, calls } = makeFakeMppAdapter({});
    handles.ctx.mppAdapter = adapter;
    const headers = authHeaders({
      idempotencyKey: IDEM_KEY,
      payment: credentialToHeaderLine(HASH_CRED),
    });
    const first = await handles.app.inject({
      method: "POST",
      url: "/mpp/charge",
      headers,
      payload: chargeBody(),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().replayed).toBe(false);

    const second = await handles.app.inject({
      method: "POST",
      url: "/mpp/charge",
      headers,
      payload: chargeBody(),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(true);
    // Second request also re-runs verify+settle on the adapter (the
    // adapter's own idempotency on the upstream tx is what protects
    // against double on-chain settle; this layer just doesn't double-
    // persist the payments row).
    expect(calls.verify).toHaveLength(2);
    expect(calls.settle).toHaveLength(2);
    expect(handles.ledger.payments.size).toBe(1);
  });

  it("WWW-Authenticate header round-trips through the adapter parser", async () => {
    handles = await makeTestServer({});
    const { adapter } = makeFakeMppAdapter({});
    handles.ctx.mppAdapter = adapter;
    const res = await handles.app.inject({
      method: "POST",
      url: "/mpp/charge",
      headers: authHeaders({ idempotencyKey: IDEM_KEY }),
      payload: chargeBody({ description: "round-trip-test" }),
    });
    expect(res.statusCode).toBe(402);
    const wwwAuth = String(res.headers["www-authenticate"]);
    expect(wwwAuth).toContain('id="' + IDEM_KEY + '"');
    expect(wwwAuth).toContain('method="tempo"');
    expect(wwwAuth).toContain('intent="charge"');
    expect(wwwAuth).toContain('realm="');
  });
});
