import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "../src/session.js";
import { handleInitSession } from "../src/tools/init-session.js";
import { handlePayAndCall } from "../src/tools/pay-and-call.js";
import type { Config } from "../src/config.js";
import { GatewayClient } from "../src/gateway-client.js";
import { startMockX402Server, type MockX402Server } from "./mock-x402-server.js";

// Canonical BIP-39 test mnemonic — publicly known, NEVER associated with real funds.
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// Known facilitator (grantee) address — fixture, not a real funded grantee.
const TEST_FACILITATOR = "noble1xe8469hdzc7t65jlxwxhhp48tkk3w0uykewsuy";
// Base USDC contract — for EVM tests.
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const baseConfig: Config = {
  port: 3100,
  host: "127.0.0.1",
  gatewayUrl: "http://localhost:3000",
  adminApiKey: "test-admin-key",
  sessionTimeoutMs: 60_000,
  externalCallTimeoutMs: 5_000,
};

interface MockGatewayCall {
  method: string;
  path: string;
  idempotencyKey?: string;
  body: unknown;
}

function makeMockGateway(opts: {
  settleHandler: (body: unknown, idem: string) => unknown;
}): {
  client: GatewayClient;
  calls: MockGatewayCall[];
  uniqueIdempotencyKeys: () => string[];
} {
  const calls: MockGatewayCall[] = [];
  // In-memory idempotency replay: same key returns the same response.
  const responseCache = new Map<string, unknown>();

  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    const headerObj = init?.headers as Record<string, string> | undefined;
    const idem =
      headerObj?.["Idempotency-Key"] ?? headerObj?.["idempotency-key"] ?? undefined;
    const bodyRaw = init?.body;
    const bodyParsed: unknown = typeof bodyRaw === "string" ? JSON.parse(bodyRaw) : null;
    const call: MockGatewayCall = { method, path, body: bodyParsed };
    if (idem !== undefined) call.idempotencyKey = idem;
    calls.push(call);

    if (path === "/settle") {
      if (idem === undefined) {
        return jsonResponse(
          { code: "invalid_request", message: "missing idem" },
          400,
        );
      }
      const cached = responseCache.get(idem);
      if (cached !== undefined) return jsonResponse(cached, 200);
      const fresh = opts.settleHandler(bodyParsed, idem);
      responseCache.set(idem, fresh);
      return jsonResponse(fresh, 200);
    }
    return jsonResponse({ code: "not_found" }, 404);
  }) as typeof fetch;

  const client = new GatewayClient({
    baseUrl: "http://gateway.test",
    adminKey: "test-admin-key",
    fetchImpl,
    settleTimeoutMs: 5_000,
  });

  return {
    client,
    calls,
    uniqueIdempotencyKeys: () =>
      Array.from(new Set(calls.filter((c) => c.idempotencyKey).map((c) => c.idempotencyKey!))),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("pay_and_call — Cosmos integration (real signer, mocked gateway, mock x402 server)", () => {
  let store: SessionStore;
  let mock: MockX402Server;

  beforeEach(async () => {
    store = new SessionStore();
    mock = await startMockX402Server({
      routes: {
        "/weather": {
          paymentRequired: {
            x402Version: 2,
            resource: {
              url: "http://placeholder/weather",
              description: "current weather",
            },
            accepts: [
              {
                scheme: "exact_cosmos_authz",
                network: "cosmos:grand-1",
                amount: "10000",
                asset: "uusdc",
                payTo: "noble1recipient00000000000000000000000merchant",
                maxTimeoutSeconds: 60,
                extra: { facilitator: TEST_FACILITATOR, chainId: "grand-1" },
              },
            ],
          },
          successBody: { weather: "sunny", tempF: 72 },
        },
      },
    });
  });

  afterEach(async () => {
    store.destroyAll();
    await mock.close();
  });

  async function bootSession(): Promise<string> {
    const init = await handleInitSession(
      { secret: TEST_MNEMONIC, networks: ["cosmos:grand-1"] },
      { store, config: baseConfig },
    );
    if (!init.ok) throw new Error(`init failed: ${init.error.message}`);
    return init.result.sessionId;
  }

  it("returns weather data after a full 402 → sign → settle → retry cycle", async () => {
    const sessionId = await bootSession();
    const gw = makeMockGateway({
      settleHandler: () => ({
        paymentId: "pay_test_001",
        status: "settled",
        txHash: "ABCDEF1234",
        providerId: "cosmos-pay",
        network: "cosmos:grand-1",
        amount: "10000",
        asset: "uusdc",
      }),
    });

    const result = await handlePayAndCall(
      { sessionId, url: `${mock.baseUrl}/weather`, method: "GET" },
      { store, gateway: gw.client, config: baseConfig },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.status).toBe("settled");
    expect(result.result.paymentId).toBe("pay_test_001");
    expect(result.result.txHash).toBe("ABCDEF1234");
    expect(result.result.network).toBe("cosmos:grand-1");
    expect(result.result.response.status).toBe(200);
    expect(result.result.response.body).toEqual({ weather: "sunny", tempF: 72 });

    // Mock x402 server should have seen one unpaid and one paid call.
    const counts = mock.callCounts();
    expect(counts["/weather"]).toEqual({ unpaid: 1, paid: 1 });
    expect(mock.receivedPaymentProofs()).toHaveLength(1);
  });

  it("is idempotent: two pay_and_call invocations for the same (url, body, payer) within the same hour use the same Idempotency-Key", async () => {
    const sessionId = await bootSession();
    const gw = makeMockGateway({
      settleHandler: () => ({
        paymentId: "pay_idem_001",
        status: "settled",
        txHash: "DEADBEEF",
        providerId: "cosmos-pay",
        network: "cosmos:grand-1",
        amount: "10000",
        asset: "uusdc",
      }),
    });
    // Pin time so the hour bucket is deterministic.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const first = await handlePayAndCall(
        { sessionId, url: `${mock.baseUrl}/weather`, method: "GET" },
        { store, gateway: gw.client, config: baseConfig },
      );
      const second = await handlePayAndCall(
        { sessionId, url: `${mock.baseUrl}/weather`, method: "GET" },
        { store, gateway: gw.client, config: baseConfig },
      );
      expect(first.ok && second.ok).toBe(true);
      expect(gw.uniqueIdempotencyKeys()).toHaveLength(1);
      // Both /settle calls return the same paymentId because the mock
      // gateway replays by key.
      if (first.ok && second.ok) {
        expect(first.result.paymentId).toBe(second.result.paymentId);
      }
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("rejects when the resource offers only networks the session isn't configured for", async () => {
    const sessionId = await bootSession();
    const gw = makeMockGateway({
      settleHandler: () => ({ paymentId: "p", status: "settled", txHash: "t" }),
    });

    // Reconfigure mock to ask for EVM payment that the cosmos-only
    // session cannot produce.
    await mock.close();
    mock = await startMockX402Server({
      routes: {
        "/weather": {
          paymentRequired: {
            x402Version: 2,
            accepts: [
              {
                scheme: "exact",
                network: "eip155:8453",
                amount: "100000",
                asset: BASE_USDC,
                payTo: "0x000000000000000000000000000000000000dEaD",
                maxTimeoutSeconds: 60,
                extra: { name: "USD Coin", version: "2" },
              },
            ],
          },
          successBody: { weather: "sunny" },
        },
      },
    });

    const result = await handlePayAndCall(
      { sessionId, url: `${mock.baseUrl}/weather` },
      { store, gateway: gw.client, config: baseConfig },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("no_compatible_payment_option");
  });

  it("returns no_payment_required when the endpoint doesn't gate on payment", async () => {
    const sessionId = await bootSession();
    // Repoint the mock to /open which 404s — i.e. not a 402.
    const gw = makeMockGateway({
      settleHandler: () => ({ paymentId: "p", status: "settled" }),
    });
    const result = await handlePayAndCall(
      { sessionId, url: `${mock.baseUrl}/open` },
      { store, gateway: gw.client, config: baseConfig },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.status).toBe("no_payment_required");
    expect(result.result.response.status).toBe(404);
    // Should not have called /settle.
    expect(gw.calls.find((c) => c.path === "/settle")).toBeUndefined();
  });

  it("surfaces a sanitized error when the settle response is non-settled", async () => {
    const sessionId = await bootSession();
    const gw = makeMockGateway({
      settleHandler: () => ({
        paymentId: "pay_failed_001",
        status: "failed",
        errorCode: "insufficient_funds",
        errorMessage: "payer does not have enough USDC",
      }),
    });
    const result = await handlePayAndCall(
      { sessionId, url: `${mock.baseUrl}/weather` },
      { store, gateway: gw.client, config: baseConfig },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("insufficient_funds");
    // The mnemonic must NEVER appear in the surfaced error.
    expect(result.error.message).not.toContain("abandon");
  });

  it("returns session_not_found for an unknown sessionId", async () => {
    const gw = makeMockGateway({ settleHandler: () => ({}) });
    const result = await handlePayAndCall(
      {
        sessionId: "00000000-0000-0000-0000-000000000000",
        url: `${mock.baseUrl}/weather`,
      },
      { store, gateway: gw.client, config: baseConfig },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("session_not_found");
  });
});

describe("pay_and_call — EVM integration (real signer, mocked gateway, mock x402 server)", () => {
  let store: SessionStore;
  let mock: MockX402Server;

  beforeEach(async () => {
    store = new SessionStore();
    mock = await startMockX402Server({
      routes: {
        "/data": {
          paymentRequired: {
            x402Version: 2,
            resource: { url: "http://placeholder/data" },
            accepts: [
              {
                scheme: "exact",
                network: "eip155:8453",
                amount: "100000",
                asset: BASE_USDC,
                payTo: "0x000000000000000000000000000000000000dEaD",
                maxTimeoutSeconds: 60,
                extra: { name: "USD Coin", version: "2" },
              },
            ],
          },
          successBody: { ok: true, payload: "premium-data" },
        },
      },
    });
  });

  afterEach(async () => {
    store.destroyAll();
    await mock.close();
  });

  it("signs an EIP-3009 payload and completes the full flow on Base USDC", async () => {
    const init = await handleInitSession(
      { secret: TEST_MNEMONIC, networks: ["eip155:8453"] },
      { store, config: baseConfig },
    );
    if (!init.ok) throw new Error(init.error.message);
    const sessionId = init.result.sessionId;

    const gw = makeMockGateway({
      settleHandler: () => ({
        paymentId: "pay_evm_001",
        status: "settled",
        txHash: "0xabc123",
        providerId: "coinbase-cdp",
        network: "eip155:8453",
      }),
    });

    const result = await handlePayAndCall(
      { sessionId, url: `${mock.baseUrl}/data` },
      { store, gateway: gw.client, config: baseConfig },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.status).toBe("settled");
    expect(result.result.network).toBe("eip155:8453");
    expect(result.result.txHash).toBe("0xabc123");
    expect(result.result.response.body).toEqual({ ok: true, payload: "premium-data" });
    expect(mock.callCounts()["/data"]).toEqual({ unpaid: 1, paid: 1 });
  });

  it("rejects with a clear error when the EVM accepts entry is missing extra.name", async () => {
    await mock.close();
    mock = await startMockX402Server({
      routes: {
        "/data": {
          paymentRequired: {
            x402Version: 2,
            accepts: [
              {
                scheme: "exact",
                network: "eip155:8453",
                amount: "100000",
                asset: BASE_USDC,
                payTo: "0x000000000000000000000000000000000000dEaD",
                maxTimeoutSeconds: 60,
                // extra omitted
              },
            ],
          },
          successBody: { ok: true },
        },
      },
    });

    const init = await handleInitSession(
      { secret: TEST_MNEMONIC, networks: ["eip155:8453"] },
      { store, config: baseConfig },
    );
    if (!init.ok) throw new Error(init.error.message);

    const gw = makeMockGateway({ settleHandler: () => ({}) });
    const result = await handlePayAndCall(
      { sessionId: init.result.sessionId, url: `${mock.baseUrl}/data` },
      { store, gateway: gw.client, config: baseConfig },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("signing_failed");
  });
});
