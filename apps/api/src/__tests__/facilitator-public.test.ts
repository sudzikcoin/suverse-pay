import { afterEach, describe, expect, it } from "vitest";
import {
  makeFakeProvider,
  makeTestServer,
  paymentPayload,
  paymentRequirements,
  type TestServerHandles,
} from "./helpers.js";

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Cosmos was repointed from `cosmos:grand-1` testnet to `cosmos:noble-1`
// mainnet on 2026-05-30 (routing-config.ts comment + commit 6f24e69).
// These fixtures track the live route the facilitator advertises.
function cosmosRequirements(): ReturnType<typeof paymentRequirements> {
  return {
    ...paymentRequirements(),
    network: "cosmos:noble-1",
  };
}

function cosmosPayload(): ReturnType<typeof paymentPayload> {
  return {
    ...paymentPayload(),
    network: "cosmos:noble-1",
  };
}

describe("GET /facilitator/supported (open access — no auth)", () => {
  let handles: TestServerHandles | null = null;
  afterEach(async () => {
    await handles?.app.close();
    handles = null;
  });

  it("does NOT require an Authorization header", async () => {
    handles = await makeTestServer({
      providers: [{ fake: makeFakeProvider({ id: "cosmos-pay" }) }],
    });
    const res = await handles.app.inject({
      method: "GET",
      url: "/facilitator/supported",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.kinds)).toBe(true);
    expect(body.extensions).toEqual([]);
    expect(body.signers).toEqual({});
  });

  it("returns only routes whose configured adapter is currently registered", async () => {
    // No adapters registered → kinds should be empty (we don't
    // advertise capabilities we can't actually serve).
    handles = await makeTestServer({ providers: [] });
    const res = await handles.app.inject({
      method: "GET",
      url: "/facilitator/supported",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kinds).toEqual([]);
  });

  it("advertises cosmos:noble-1 when cosmos-pay is registered", async () => {
    handles = await makeTestServer({
      providers: [{ fake: makeFakeProvider({ id: "cosmos-pay" }) }],
    });
    const res = await handles.app.inject({
      method: "GET",
      url: "/facilitator/supported",
    });
    const kinds = res.json().kinds as Array<Record<string, unknown>>;
    expect(kinds).toContainEqual({
      x402Version: 2,
      scheme: "exact_cosmos_authz",
      network: "cosmos:noble-1",
    });
  });

  it("advertises Solana mainnet when EITHER cdp OR payai is registered (priority list)", async () => {
    // Only PayAI registered — CDP is the primary but is missing.
    // The route is still advertised because PayAI is the failover.
    handles = await makeTestServer({
      providers: [{ fake: makeFakeProvider({ id: "payai" }) }],
    });
    const res = await handles.app.inject({
      method: "GET",
      url: "/facilitator/supported",
    });
    const kinds = res.json().kinds as Array<Record<string, unknown>>;
    expect(kinds).toContainEqual({
      x402Version: 2,
      scheme: "exact",
      network: SOLANA_MAINNET,
    });
  });
});

describe("GET /facilitator/health (open access — no auth)", () => {
  let handles: TestServerHandles | null = null;
  afterEach(async () => {
    await handles?.app.close();
    handles = null;
  });

  it("returns {status: ok, x402Version: 2} without auth", async () => {
    handles = await makeTestServer({});
    const res = await handles.app.inject({
      method: "GET",
      url: "/facilitator/health",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", x402Version: 2 });
  });
});

describe("POST /facilitator/verify (open access — no auth)", () => {
  let handles: TestServerHandles | null = null;
  afterEach(async () => {
    await handles?.app.close();
    handles = null;
  });

  it("does NOT require an Authorization header", async () => {
    const cosmos = makeFakeProvider({
      id: "cosmos-pay",
      verify: () => ({
        valid: true,
        providerId: "cosmos-pay",
        verifiedAt: "2026-05-28T00:00:00.000Z",
        payer: "noble1payer",
      }),
    });
    handles = await makeTestServer({ providers: [{ fake: cosmos }] });
    const res = await handles.app.inject({
      method: "POST",
      url: "/facilitator/verify",
      payload: {
        paymentPayload: cosmosPayload(),
        paymentRequirements: cosmosRequirements(),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ isValid: true, payer: "noble1payer" });
  });

  it("returns x402-spec-shaped {isValid, invalidReason} on failure", async () => {
    const cosmos = makeFakeProvider({
      id: "cosmos-pay",
      verify: () => ({
        valid: false,
        providerId: "cosmos-pay",
        verifiedAt: "2026-05-28T00:00:00.000Z",
        errorCode: "invalid_authorization",
        errorMessage: "validity window exceeded",
      }),
    });
    handles = await makeTestServer({ providers: [{ fake: cosmos }] });
    const res = await handles.app.inject({
      method: "POST",
      url: "/facilitator/verify",
      payload: {
        paymentPayload: cosmosPayload(),
        paymentRequirements: cosmosRequirements(),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      isValid: false,
      invalidReason: "invalid_authorization",
    });
  });

  it("returns 400 route_unsupported when no adapter is configured for the route", async () => {
    handles = await makeTestServer({ providers: [] });
    const res = await handles.app.inject({
      method: "POST",
      url: "/facilitator/verify",
      payload: {
        paymentPayload: cosmosPayload(),
        paymentRequirements: cosmosRequirements(),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("route_unsupported");
  });

  it("returns 400 on invalid body schema", async () => {
    handles = await makeTestServer({
      providers: [{ fake: makeFakeProvider({ id: "cosmos-pay" }) }],
    });
    const res = await handles.app.inject({
      method: "POST",
      url: "/facilitator/verify",
      payload: { not_a_payment: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("/facilitator/settle is NOT registered when ctx.pool is undefined (test fixture)", async () => {
    handles = await makeTestServer({
      providers: [{ fake: makeFakeProvider({ id: "cosmos-pay" }) }],
    });
    const res = await handles.app.inject({
      method: "POST",
      url: "/facilitator/settle",
      payload: {
        paymentPayload: cosmosPayload(),
        paymentRequirements: cosmosRequirements(),
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("does NOT collide with the existing admin-auth /verify route", async () => {
    // The server-wide admin-auth hook MUST skip /facilitator/* —
    // otherwise this POST without an Authorization header would 401
    // before reaching the route handler.
    handles = await makeTestServer({
      providers: [{ fake: makeFakeProvider({ id: "cosmos-pay" }) }],
    });
    const res = await handles.app.inject({
      method: "POST",
      url: "/facilitator/verify",
      payload: {
        paymentPayload: cosmosPayload(),
        paymentRequirements: cosmosRequirements(),
      },
    });
    expect(res.statusCode).not.toBe(401);
  });
});
