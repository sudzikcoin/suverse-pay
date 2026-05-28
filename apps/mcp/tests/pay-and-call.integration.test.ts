import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "../src/session.js";
import { handleInitSession } from "../src/tools/init-session.js";
import {
  handlePayAndCall,
  _resetIdempotencyCacheForTests,
} from "../src/tools/pay-and-call.js";
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
// Solana fixtures — public test mints / facilitator pubkeys, no funds.
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_RECIPIENT = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const SOLANA_FEE_PAYER = "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd";
// Deterministic blockhash for offline tests. Real blockhashes are
// base58 of a recent block's hash; this is `Buffer.alloc(32, 7)` (the
// 32-byte sentinel used by signer-solana's own tests) base58-encoded.
const TEST_BLOCKHASH = "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx";

const baseConfig: Config = {
  port: 3100,
  host: "127.0.0.1",
  gatewayUrl: "http://localhost:3000",
  adminApiKey: "test-admin-key",
  sessionTimeoutMs: 60_000,
  externalCallTimeoutMs: 5_000,
  solanaRpcUrlMainnet: "https://api.mainnet-beta.solana.com",
  solanaRpcUrlDevnet: "https://api.devnet.solana.com",
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

describe("pay_and_call — flat PaymentRequirements shape (cosmos-pay middleware convention)", () => {
  let store: SessionStore;
  let mock: MockX402Server;

  beforeEach(async () => {
    store = new SessionStore();
    // This mock emits a FLAT PaymentRequirements object (no
    // accepts[] wrapper), which is what x402-cosmos middleware does:
    //   { scheme, network, maxAmountRequired, asset, payTo, extra }
    mock = await startMockX402Server({
      routes: {
        "/premium": {
          paymentRequired: {
            // Cast through any because the mock type expects an
            // accepts[] wrapper; the test exercises the wider parser.
            ...({
              scheme: "exact_cosmos_authz",
              network: "cosmos:grand-1",
              maxAmountRequired: "10000",
              asset: "uusdc",
              payTo: "noble1t74j8lz7hwf0c3y7cpklc8agkpemagrjl672w0",
              resource: "http://placeholder/premium",
              description: "One call to the premium endpoint",
              maxTimeoutSeconds: 60,
              extra: { facilitator: TEST_FACILITATOR, chainId: "grand-1", decimals: 6, symbol: "USDC" },
            } as unknown as { x402Version: number; accepts: never[] }),
          },
          successBody: { data: "the secret of life is 42" },
        },
      },
    });
  });

  afterEach(async () => {
    store.destroyAll();
    await mock.close();
  });

  it("parses a flat PaymentRequirements body (no accepts[] wrapper) and signs successfully", async () => {
    const init = await handleInitSession(
      { secret: TEST_MNEMONIC, networks: ["cosmos:grand-1"] },
      { store, config: baseConfig },
    );
    if (!init.ok) throw new Error(init.error.message);
    const sessionId = init.result.sessionId;

    const gw = makeMockGateway({
      settleHandler: () => ({
        paymentId: "pay_flat_001",
        status: "settled",
        txHash: "FLATTX",
        providerId: "cosmos-pay",
        network: "cosmos:grand-1",
      }),
    });

    const result = await handlePayAndCall(
      { sessionId, url: `${mock.baseUrl}/premium` },
      { store, gateway: gw.client, config: baseConfig },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.status).toBe("settled");
    expect(result.result.response.body).toEqual({ data: "the secret of life is 42" });
  });
});

describe("pay_and_call — Cosmos integration (real signer, mocked gateway, mock x402 server)", () => {
  let store: SessionStore;
  let mock: MockX402Server;

  beforeEach(async () => {
    store = new SessionStore();
    _resetIdempotencyCacheForTests();
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

  it("returns weather data after a full 402 → sign → POST PAYMENT-SIGNATURE → 200 cycle", async () => {
    const sessionId = await bootSession();
    const gw = makeMockGateway({ settleHandler: () => ({}) });

    const result = await handlePayAndCall(
      { sessionId, url: `${mock.baseUrl}/weather`, method: "GET" },
      { store, gateway: gw.client, config: baseConfig },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.status).toBe("settled");
    // paymentId is now MCP-synthesized, stable across replays.
    expect(result.result.paymentId).toMatch(/^mcp_[0-9a-f]{32}$/);
    // txHash comes from the resource server's PAYMENT-RESPONSE header
    // (mock x402 sets transaction="0xmocktxhash").
    expect(result.result.txHash).toBe("0xmocktxhash");
    expect(result.result.network).toBe("cosmos:grand-1");
    expect(result.result.response.status).toBe(200);
    expect(result.result.response.body).toEqual({ weather: "sunny", tempF: 72 });

    // Mock x402 server should have seen one unpaid and one paid call.
    const counts = mock.callCounts();
    expect(counts["/weather"]).toEqual({ unpaid: 1, paid: 1 });
    expect(mock.receivedPaymentProofs()).toHaveLength(1);
    // pay_and_call no longer talks to the gateway directly.
    expect(gw.calls.find((c) => c.path === "/settle")).toBeUndefined();
  });

  it("replays from cache without re-signing or re-submitting (no second on-chain tx)", async () => {
    const sessionId = await bootSession();
    const gw = makeMockGateway({ settleHandler: () => ({}) });
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
      if (!first.ok || !second.ok) return;
      // Same paymentId proves cache hit. Same txHash proves the cached
      // result was returned (no fresh submission).
      expect(first.result.paymentId).toBe(second.result.paymentId);
      expect(first.result.txHash).toBe(second.result.txHash);
      // Second invocation reports as a replay.
      expect(first.result.idempotentReplay).toBeFalsy();
      expect(second.result.idempotentReplay).toBe(true);
      // STRONGEST INVARIANT: mock x402 saw only ONE paid call total.
      // The second pay_and_call short-circuited via cache and never
      // hit the resource server (would have minted a second tx).
      expect(mock.callCounts()["/weather"]).toEqual({ unpaid: 1, paid: 1 });
      expect(mock.receivedPaymentProofs()).toHaveLength(1);
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

  it("surfaces payment_rejected when the resource server returns 402 on retry (facilitator settle failure)", async () => {
    // Swap the mock to one that NEVER accepts payment (always returns
    // 402 with a PAYMENT-RESPONSE failure reason).
    await mock.close();
    mock = await startMockX402Server({
      routes: {
        "/weather": {
          paymentRequired: {
            x402Version: 2,
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
          successBody: { weather: "sunny" },
          alwaysFail: { errorReason: "insufficient_funds" },
        },
      },
    });
    const sessionId = await bootSession();
    const gw = makeMockGateway({ settleHandler: () => ({}) });
    const result = await handlePayAndCall(
      { sessionId, url: `${mock.baseUrl}/weather` },
      { store, gateway: gw.client, config: baseConfig },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("payment_rejected");
    expect(result.error.message).toContain("insufficient_funds");
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

    const gw = makeMockGateway({ settleHandler: () => ({}) });

    const result = await handlePayAndCall(
      { sessionId, url: `${mock.baseUrl}/data` },
      { store, gateway: gw.client, config: baseConfig },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.status).toBe("settled");
    expect(result.result.network).toBe("eip155:8453");
    // txHash sourced from the mock x402's PAYMENT-RESPONSE header.
    expect(result.result.txHash).toBe("0xmocktxhash");
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

describe("pay_and_call — Solana integration (real signer, mocked gateway, mock x402 server, injected blockhash)", () => {
  let store: SessionStore;
  let mock: MockX402Server;

  beforeEach(async () => {
    store = new SessionStore();
    _resetIdempotencyCacheForTests();
  });

  afterEach(async () => {
    store.destroyAll();
    if (mock) await mock.close();
  });

  it("signs an SPL transferChecked on Solana devnet and completes the 402 → settle cycle", async () => {
    mock = await startMockX402Server({
      routes: {
        "/svm-data": {
          paymentRequired: {
            x402Version: 2,
            resource: { url: "http://placeholder/svm-data" },
            accepts: [
              {
                scheme: "exact",
                network: SOLANA_DEVNET,
                amount: "1000",
                asset: SOLANA_USDC_MINT,
                payTo: SOLANA_RECIPIENT,
                maxTimeoutSeconds: 60,
                extra: { feePayer: SOLANA_FEE_PAYER, decimals: 6, symbol: "USDC" },
              },
            ],
          },
          successBody: { svmPayload: "premium-bytes" },
        },
      },
    });
    const init = await handleInitSession(
      { secret: TEST_MNEMONIC, networks: [SOLANA_DEVNET] },
      { store, config: baseConfig },
    );
    if (!init.ok) throw new Error(init.error.message);

    // No outbound RPC: deps.blockhashFetcher short-circuits to a
    // deterministic fixture so this test stays fully offline.
    const blockhashFetcher = async (network: string): Promise<string> => {
      expect(network).toBe(SOLANA_DEVNET);
      return TEST_BLOCKHASH;
    };

    const gw = makeMockGateway({ settleHandler: () => ({}) });
    const result = await handlePayAndCall(
      { sessionId: init.result.sessionId, url: `${mock.baseUrl}/svm-data` },
      { store, gateway: gw.client, config: baseConfig, blockhashFetcher },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.status).toBe("settled");
    expect(result.result.network).toBe(SOLANA_DEVNET);
    expect(result.result.response.body).toEqual({ svmPayload: "premium-bytes" });
    expect(mock.callCounts()["/svm-data"]).toEqual({ unpaid: 1, paid: 1 });

    // Decode the PAYMENT-SIGNATURE header that the mock server received;
    // it must be a v2 PaymentPayload with scheme=exact, network=devnet,
    // and a non-empty base64 transaction.
    const proofs = mock.receivedPaymentProofs();
    expect(proofs).toHaveLength(1);
    const decoded = JSON.parse(Buffer.from(proofs[0]!, "base64").toString("utf8"));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.scheme).toBe("exact");
    expect(decoded.network).toBe(SOLANA_DEVNET);
    expect(typeof decoded.payload.transaction).toBe("string");
    expect(decoded.payload.transaction.length).toBeGreaterThan(0);
  });

  it("returns missing_solana_fee_payer when the 402 omits extra.feePayer", async () => {
    mock = await startMockX402Server({
      routes: {
        "/svm-data": {
          paymentRequired: {
            x402Version: 2,
            accepts: [
              {
                scheme: "exact",
                network: SOLANA_MAINNET,
                amount: "1000",
                asset: SOLANA_USDC_MINT,
                payTo: SOLANA_RECIPIENT,
                maxTimeoutSeconds: 60,
                // extra.feePayer intentionally absent
                extra: { decimals: 6 },
              },
            ],
          },
          successBody: { ok: true },
        },
      },
    });
    const init = await handleInitSession(
      { secret: TEST_MNEMONIC, networks: [SOLANA_MAINNET] },
      { store, config: baseConfig },
    );
    if (!init.ok) throw new Error(init.error.message);

    const blockhashFetcher = async () => TEST_BLOCKHASH;
    const gw = makeMockGateway({ settleHandler: () => ({}) });
    const result = await handlePayAndCall(
      { sessionId: init.result.sessionId, url: `${mock.baseUrl}/svm-data` },
      { store, gateway: gw.client, config: baseConfig, blockhashFetcher },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("missing_solana_fee_payer");
    // No paid call should have hit the mock server.
    expect(mock.callCounts()["/svm-data"]).toEqual({ unpaid: 1, paid: 0 });
  });

  it("surfaces solana_blockhash_fetch_failed when the RPC fetcher throws", async () => {
    mock = await startMockX402Server({
      routes: {
        "/svm-data": {
          paymentRequired: {
            x402Version: 2,
            accepts: [
              {
                scheme: "exact",
                network: SOLANA_DEVNET,
                amount: "1000",
                asset: SOLANA_USDC_MINT,
                payTo: SOLANA_RECIPIENT,
                maxTimeoutSeconds: 60,
                extra: { feePayer: SOLANA_FEE_PAYER, decimals: 6 },
              },
            ],
          },
          successBody: { ok: true },
        },
      },
    });
    const init = await handleInitSession(
      { secret: TEST_MNEMONIC, networks: [SOLANA_DEVNET] },
      { store, config: baseConfig },
    );
    if (!init.ok) throw new Error(init.error.message);

    const blockhashFetcher = async (): Promise<string> => {
      throw new Error("simulated RPC outage");
    };
    const gw = makeMockGateway({ settleHandler: () => ({}) });
    const result = await handlePayAndCall(
      { sessionId: init.result.sessionId, url: `${mock.baseUrl}/svm-data` },
      { store, gateway: gw.client, config: baseConfig, blockhashFetcher },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("solana_blockhash_fetch_failed");
    expect(result.error.message).toContain("simulated RPC outage");
    // Mnemonic must NEVER leak into surfaced error messages.
    expect(result.error.message).not.toContain("abandon");
  });
});
