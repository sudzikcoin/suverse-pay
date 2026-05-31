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
    // the merge. Also satisfy the pre-charge upstream health probe
    // with a HEAD 200 from the upstream URL.
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.endsWith("/facilitator/supported")) {
        return new Response(JSON.stringify({ kinds: [] }), { status: 200 });
      }
      if (url === "https://upstream.example.com/forecast" && init?.method === "HEAD") {
        return new Response(null, { status: 200 });
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

  it("emits Cosmos challenges with scheme exact_cosmos_authz, EVM with exact", async () => {
    // The proxy used to hardcode scheme="exact" for every accept.
    // Cosmos verify/settle through cosmos-pay only routes
    // "exact_cosmos_authz" — sellers configuring a Cosmos network on
    // their proxy hit a dead-end facilitator route until the per-VM
    // mapping landed. Buyer SDK Cosmos signer also rejects "exact".
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.endsWith("/facilitator/supported")) {
        return new Response(JSON.stringify({ kinds: [] }), { status: 200 });
      }
      if (url === "https://upstream.example.com/forecast" && init?.method === "HEAD") {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const deps = makeDeps({
      store: makeStore(
        makeConfig({
          acceptedNetworks: ["eip155:8453", "cosmos:noble-1"],
          payToCosmos: "noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj",
        }),
      ),
      fetchImpl: fetchMock,
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
    expect(result.status).toBe(402);
    const body = result.body as { accepts: Array<{ scheme: string; network: string }> };
    const byNet = Object.fromEntries(body.accepts.map((a) => [a.network, a.scheme]));
    expect(byNet["eip155:8453"]).toBe("exact");
    expect(byNet["cosmos:noble-1"]).toBe("exact_cosmos_authz");
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

  it("strips nginx infrastructure headers from the upstream call", async () => {
    // Cloudflare-fronted upstreams (CoinGecko etc.) read
    // x-forwarded-* + x-real-ip as a bot signal and return 403.
    // Nginx in front of the proxy injects them on every request, so
    // they have to terminate at our edge — never reach upstream.
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
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const deps = makeDeps({ store: makeStore(makeConfig()), fetchImpl: fetchMock });
    await handle(
      {
        resourceKeyId: "reskey_test",
        slug: "weather",
        method: "POST",
        resourceUrl: "https://proxy/v1/proxy/reskey_test/weather",
        paymentHeader: Buffer.from(
          JSON.stringify({
            x402Version: 2,
            scheme: "exact",
            network: "eip155:8453",
            payload: { signature: "0xsig", authorization: {} },
          }),
        ).toString("base64"),
        idempotencyKey: "test-idem-fwd",
        incomingHeaders: {
          "content-type": "application/json",
          "x-forwarded-for": "1.2.3.4, 5.6.7.8",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "proxy.suverse.io",
          "x-real-ip": "1.2.3.4",
          "user-agent": "buyer-sdk/1.0",
        },
        body: Buffer.from("{}"),
        clientIp: "1.2.3.4",
      },
      deps,
    );
    const upstreamCall = fetchMock.mock.calls.find(
      ([u]) => u === "https://upstream.example.com/forecast",
    )!;
    const upstreamHeaders = (upstreamCall[1] as { headers: Record<string, string> })
      .headers;
    expect(upstreamHeaders["x-forwarded-for"]).toBeUndefined();
    expect(upstreamHeaders["x-forwarded-proto"]).toBeUndefined();
    expect(upstreamHeaders["x-forwarded-host"]).toBeUndefined();
    expect(upstreamHeaders["x-real-ip"]).toBeUndefined();
    // user-agent must still pass through — it's a legitimate end-to-end
    // header buyers control.
    expect(upstreamHeaders["user-agent"]).toBe("buyer-sdk/1.0");
  });

  it("drops content-encoding + content-length from the upstream response", async () => {
    // undici's Response.arrayBuffer() returns the DECODED body, so any
    // Content-Encoding the upstream advertised is now a lie. Forwarding
    // it makes the buyer's HTTP client (also undici, typically) try to
    // gunzip already-plain bytes — the connection drops mid-stream with
    // "terminated" and no useful diagnostic. Strip the encoding pair
    // and let Fastify recompute Content-Length from the actual Buffer.
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
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
            "content-length": "9999",
            "cache-control": "max-age=30",
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const deps = makeDeps({ store: makeStore(makeConfig()), fetchImpl: fetchMock });
    const result = await handle(
      {
        resourceKeyId: "reskey_test",
        slug: "weather",
        method: "POST",
        resourceUrl: "https://proxy/v1/proxy/reskey_test/weather",
        paymentHeader: Buffer.from(
          JSON.stringify({
            x402Version: 2,
            scheme: "exact",
            network: "eip155:8453",
            payload: { signature: "0xsig", authorization: {} },
          }),
        ).toString("base64"),
        idempotencyKey: "test-idem-enc",
        incomingHeaders: { "content-type": "application/json" },
        body: Buffer.from("{}"),
        clientIp: "1.2.3.4",
      },
      deps,
    );
    expect(result.status).toBe(200);
    expect(result.headers["content-encoding"]).toBeUndefined();
    expect(result.headers["content-length"]).toBeUndefined();
    // Non-stripped upstream headers should pass through.
    expect(result.headers["content-type"]).toBe("application/json");
    expect(result.headers["cache-control"]).toBe("max-age=30");
  });

  it("returns 503 upstream_unavailable when probe sees HEAD 503", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === "https://upstream.example.com/forecast" && init?.method === "HEAD") {
        return new Response(null, { status: 503 });
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
    expect(result.status).toBe(503);
    expect(result.outcome).toBe("upstream_error");
    const body = result.body as { error: string; reason: string; upstreamStatus?: number };
    expect(body.error).toBe("upstream_unavailable");
    expect(body.reason).toBe("upstream_5xx");
    expect(body.upstreamStatus).toBe(503);
    expect(result.headers["retry-after"]).toBe("30");
    // The facilitator's /supported endpoint must NOT have been called —
    // we short-circuit before runProtocol when the probe fails.
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).endsWith("/facilitator/supported")),
    ).toBe(false);
  });

  it("returns 503 upstream_unavailable when probe hits a network error", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === "https://upstream.example.com/forecast" && init?.method === "HEAD") {
        throw new TypeError("fetch failed");
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
    expect(result.status).toBe(503);
    expect(result.outcome).toBe("upstream_error");
    const body = result.body as { reason: string };
    expect(body.reason).toBe("network_error");
  });

  it("emits 402 (not 503) when probe sees HEAD 404 — endpoint gated, server alive", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.endsWith("/facilitator/supported")) {
        return new Response(JSON.stringify({ kinds: [] }), { status: 200 });
      }
      if (url === "https://upstream.example.com/forecast" && init?.method === "HEAD") {
        return new Response(null, { status: 404 });
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
  });

  it("skips the probe entirely when X-Payment is present", async () => {
    // No HEAD handler in the mock — if the probe ran, the test would
    // throw "unexpected fetch: HEAD ...".
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/facilitator/supported")) {
        return new Response(JSON.stringify({ kinds: [] }), { status: 200 });
      }
      if (url.endsWith("/facilitator/verify")) {
        return new Response(
          JSON.stringify({ isValid: false, invalidReason: "test_only" }),
          { status: 200 },
        );
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
        paymentHeader: Buffer.from(
          JSON.stringify({
            x402Version: 2,
            scheme: "exact",
            network: "eip155:8453",
            payload: { signature: "0xsig", authorization: {} },
          }),
        ).toString("base64"),
        idempotencyKey: "test-idem-skip",
        incomingHeaders: {},
        body: null,
        clientIp: "1.2.3.4",
      },
      deps,
    );
    // The verify mock rejects, so the protocol comes back as "rejected"
    // → 402, not 503. The key assertion is that no HEAD probe fired.
    expect(result.status).toBe(402);
    const headCalls = fetchMock.mock.calls.filter(
      ([_url, init]) => (init as { method?: string } | undefined)?.method === "HEAD",
    );
    expect(headCalls.length).toBe(0);
  });

  it("respects healthCheckTimeoutMs from deps", async () => {
    // Slow upstream HEAD that resolves after 200ms; budget is 50ms.
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: { signal?: AbortSignal; method?: string }) => {
        if (init.method !== "HEAD") throw new Error("unexpected method");
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        });
      },
    );
    const deps = makeDeps({ fetchImpl: fetchMock, healthCheckTimeoutMs: 50 });
    const t0 = Date.now();
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
    const elapsed = Date.now() - t0;
    expect(result.status).toBe(503);
    expect((result.body as { reason: string }).reason).toBe("timeout");
    // Must not have waited the default 3s.
    expect(elapsed).toBeLessThan(2_000);
  });

  it("attaches extensions.bazaar to the 402 when catalog lookup returns a row", async () => {
    // Pins the wiring from CatalogBazaarStore → buildBazaarExtension →
    // MiddlewareOptions.extensions → ChallengeBody.extensions. Without
    // this, the Coinbase Bazaar crawler can't catalog the proxy URL.
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.endsWith("/facilitator/supported")) {
        return new Response(JSON.stringify({ kinds: [] }), { status: 200 });
      }
      if (url === "https://upstream.example.com/forecast" && init?.method === "HEAD") {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const fakeCatalogStore = {
      lookup: vi.fn().mockResolvedValue({
        description: "Weather for NYC",
        tags: ["weather", "forecast"],
        outputExample: { temp_f: 72 },
        method: "GET" as const,
      }),
      invalidate: vi.fn(),
    } as unknown as HandleDeps["catalogStore"];
    const deps = makeDeps({
      store: makeStore(makeConfig({ originalMethod: "GET" })),
      catalogStore: fakeCatalogStore,
      fetchImpl: fetchMock,
    });
    const result = await handle(
      {
        resourceKeyId: "reskey_test",
        slug: "weather",
        method: "GET",
        resourceUrl: "https://proxy.suverse.io/v1/proxy/reskey_test/weather",
        paymentHeader: undefined,
        idempotencyKey: undefined,
        incomingHeaders: {},
        body: null,
        clientIp: "1.2.3.4",
      },
      deps,
    );
    expect(result.status).toBe(402);
    const body = result.body as { extensions?: { bazaar?: { info: unknown; schema: unknown } } };
    expect(body.extensions).toBeDefined();
    expect(body.extensions?.bazaar).toBeDefined();
    expect(body.extensions?.bazaar?.info).toBeDefined();
    expect(body.extensions?.bazaar?.schema).toBeDefined();
  });

  it("omits extensions when no catalog row matches (un-approved proxy)", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.endsWith("/facilitator/supported")) {
        return new Response(JSON.stringify({ kinds: [] }), { status: 200 });
      }
      if (url === "https://upstream.example.com/forecast" && init?.method === "HEAD") {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const fakeCatalogStore = {
      lookup: vi.fn().mockResolvedValue(null),
      invalidate: vi.fn(),
    } as unknown as HandleDeps["catalogStore"];
    const deps = makeDeps({
      catalogStore: fakeCatalogStore,
      fetchImpl: fetchMock,
    });
    const result = await handle(
      {
        resourceKeyId: "reskey_test",
        slug: "weather",
        method: "POST",
        resourceUrl: "https://proxy.suverse.io/v1/proxy/reskey_test/weather",
        paymentHeader: undefined,
        idempotencyKey: undefined,
        incomingHeaders: {},
        body: null,
        clientIp: "1.2.3.4",
      },
      deps,
    );
    expect(result.status).toBe(402);
    const body = result.body as { extensions?: unknown };
    expect(body.extensions).toBeUndefined();
  });
});
