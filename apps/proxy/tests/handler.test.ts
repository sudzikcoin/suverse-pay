/**
 * Handler unit tests with a stubbed Postgres pool + stubbed
 * facilitator (fetchImpl injection). Covers the four key branches:
 *
 *   1. config missing → 404
 *   2. config paused  → 503
 *   3. no payment header → 402 challenge from runProtocol
 *   4. settled        → upstream fetch executed with merged headers,
 *                       payment-response headers attached
 */

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptHeaders } from "../src/crypto.js";
import { handle, type HandleDeps } from "../src/handler.js";
import type { ProxyConfigRow } from "../src/store.js";

const MASTER_KEY = randomBytes(32);

function makeConfig(over: Partial<ProxyConfigRow> = {}): ProxyConfigRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    resourceKeyId: "reskey_test",
    endpointSlug: "weather",
    originalUrl: "https://upstream.example.com/forecast",
    originalMethod: "POST",
    displayName: "Forecast",
    description: "Weather forecast",
    priceAtomic: "50000",
    acceptedNetworks: ["eip155:8453"],
    payToEvm: "0x" + "1".repeat(40),
    payToSolana: null,
    payToCosmos: null,
    payToTron: null,
    forwardHeadersEncrypted: null,
    forwardAuthScheme: "static",
    isActive: true,
    ...over,
  };
}

function makeStore(config: ProxyConfigRow | null) {
  return {
    lookup: vi.fn().mockResolvedValue(config),
    invalidate: vi.fn(),
  } as unknown as HandleDeps["store"];
}

function makePool() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  } as unknown as HandleDeps["pool"];
}

function makeDeps(over: Partial<HandleDeps> = {}): HandleDeps {
  return {
    store: makeStore(makeConfig()),
    pool: makePool(),
    masterKey: MASTER_KEY,
    facilitatorUrl: "https://fac.example.com",
    facilitatorApiKey: "sup_live_test_key",
    fetchImpl: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
}

describe("handle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when no config exists", async () => {
    const deps = makeDeps({ store: makeStore(null) });
    const result = await handle(
      {
        resourceKeyId: "reskey_test",
        slug: "missing",
        method: "POST",
        resourceUrl: "https://proxy/v1/proxy/reskey_test/missing",
        paymentHeader: undefined,
        idempotencyKey: undefined,
        incomingHeaders: {},
        body: null,
        clientIp: "1.2.3.4",
      },
      deps,
    );
    expect(result.status).toBe(404);
    expect(result.outcome).toBe("invalid_config");
  });

  it("returns 503 paused when is_active=false", async () => {
    const deps = makeDeps({
      store: makeStore(makeConfig({ isActive: false })),
    });
    const result = await handle(
      {
        resourceKeyId: "reskey_test",
        slug: "weather",
        method: "POST",
        resourceUrl: "https://proxy/v1/proxy/reskey_test/weather",
        paymentHeader: undefined,
        idempotencyKey: undefined,
        incomingHeaders: {},
        body: null,
        clientIp: "1.2.3.4",
      },
      deps,
    );
    expect(result.status).toBe(503);
    expect(result.outcome).toBe("paused");
  });

  it("returns 405 when method doesn't match the configured method", async () => {
    const deps = makeDeps();
    const result = await handle(
      {
        resourceKeyId: "reskey_test",
        slug: "weather",
        method: "GET",
        resourceUrl: "https://proxy/v1/proxy/reskey_test/weather",
        paymentHeader: undefined,
        idempotencyKey: undefined,
        incomingHeaders: {},
        body: null,
        clientIp: "1.2.3.4",
      },
      deps,
    );
    expect(result.status).toBe(405);
    expect(result.headers["allow"]).toBe("POST");
  });

  it("returns 503 invalid_config when no payTo for the accepted networks", async () => {
    const deps = makeDeps({
      store: makeStore(
        makeConfig({
          acceptedNetworks: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
          payToEvm: null,
          payToSolana: null, // misconfigured — solana accepted but no pay_to_solana
        }),
      ),
    });
    const result = await handle(
      {
        resourceKeyId: "reskey_test",
        slug: "weather",
        method: "POST",
        resourceUrl: "https://proxy/v1/proxy/reskey_test/weather",
        paymentHeader: undefined,
        idempotencyKey: undefined,
        incomingHeaders: {},
        body: null,
        clientIp: "1.2.3.4",
      },
      deps,
    );
    expect(result.status).toBe(503);
    expect(result.outcome).toBe("invalid_config");
  });

  it("emits a 402 challenge when no payment header present", async () => {
    // Inject a fetchImpl that the facilitator's discover-extras call
    // sees first. Return an empty `accepts` so buildChallenge skips
    // the merge.
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/facilitator/supported")) {
        return new Response(JSON.stringify({ kinds: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const deps = makeDeps({ fetchImpl: fetchMock });
    const result = await handle(
      {
        resourceKeyId: "reskey_test",
        slug: "weather",
        method: "POST",
        resourceUrl: "https://proxy/v1/proxy/reskey_test/weather",
        paymentHeader: undefined,
        idempotencyKey: undefined,
        incomingHeaders: {},
        body: null,
        clientIp: "1.2.3.4",
      },
      deps,
    );
    expect(result.status).toBe(402);
    expect(result.outcome).toBe("challenge");
    const body = result.body as { accepts: unknown[] };
    expect(body.accepts.length).toBe(1);
    // payment-required header carries the challenge JSON base64'd.
    expect(result.headers["payment-required"]).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("forwards upstream + attaches PAYMENT-RESPONSE on settled", async () => {
    // Stub facilitator: discover-extras → no extras; verify → isValid;
    // settle → success with a tx hash.
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/facilitator/supported")) {
        return new Response(JSON.stringify({ kinds: [] }), { status: 200 });
      }
      if (url.endsWith("/facilitator/verify")) {
        return new Response(
          JSON.stringify({ isValid: true, payer: "0xPAYER" }),
          { status: 200 },
        );
      }
      if (url.endsWith("/facilitator/settle")) {
        return new Response(
          JSON.stringify({
            success: true,
            transaction: "0xTXHASH",
            network: "eip155:8453",
            payer: "0xPAYER",
          }),
          { status: 200 },
        );
      }
      if (url === "https://upstream.example.com/forecast") {
        return new Response(JSON.stringify({ temp_f: 72 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    // Encrypted upstream auth header.
    const encrypted = encryptHeaders(
      { "x-upstream-api-key": "secret-upstream-key" },
      MASTER_KEY,
    );
    const deps = makeDeps({
      store: makeStore(
        makeConfig({ forwardHeadersEncrypted: encrypted }),
      ),
      fetchImpl: fetchMock,
    });
    const result = await handle(
      {
        resourceKeyId: "reskey_test",
        slug: "weather",
        method: "POST",
        resourceUrl: "https://proxy/v1/proxy/reskey_test/weather",
        // Minimal v2-flat payment header — runProtocol decodes
        // base64 JSON, but a flat scheme/network/payload is OK.
        paymentHeader: Buffer.from(
          JSON.stringify({
            x402Version: 2,
            scheme: "exact",
            network: "eip155:8453",
            payload: { signature: "0xsig", authorization: {} },
          }),
        ).toString("base64"),
        idempotencyKey: "test-idem-1",
        incomingHeaders: {
          "content-type": "application/json",
          // Buyer sent their own Authorization, which should be
          // dropped (it's in HOP_BY_HOP) so we never proxy it.
          authorization: "Bearer BUYER_TOKEN",
        },
        body: Buffer.from(JSON.stringify({ zip: "94107" })),
        clientIp: "1.2.3.4",
      },
      deps,
    );
    expect(result.status).toBe(200);
    expect(result.outcome).toBe("settled");
    expect(result.headers["payment-response"]).toMatch(/^[A-Za-z0-9+/=]+$/);
    // Verify that the upstream call carried the injected header and
    // dropped the buyer's Authorization.
    const upstreamCall = fetchMock.mock.calls.find(
      ([u]) => u === "https://upstream.example.com/forecast",
    )!;
    const upstreamInit = upstreamCall[1] as { headers: Record<string, string> };
    expect(upstreamInit.headers["x-upstream-api-key"]).toBe(
      "secret-upstream-key",
    );
    expect(upstreamInit.headers["authorization"]).toBeUndefined();
    // Body forwarded verbatim.
    expect(upstreamInit).toMatchObject({ method: "POST" });
  });
});
