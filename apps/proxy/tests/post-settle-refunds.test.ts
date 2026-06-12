/**
 * Defect B (Task 57): ANY settled payment whose final response is a
 * failure we caused must leave a `refunds_pending` row. The original
 * migration-027 flow only enqueued from the upstream-x402 post-retry
 * window; the paths below all bypassed it (morning-report 20260612 —
 * two settled 502s from 0x9CC42f…, $0.30, zero queue rows).
 *
 * Covered here:
 *   - settled + upstream 5xx passthrough (plain proxy path)
 *   - settled + upstream fetch error (our 502)
 *   - settled + internal handler returning 5xx
 *   - settled + unknown internal handler (post-settle misconfig)
 *   - settled + 200 → NO refund row (control)
 */

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handle, type HandleDeps } from "../src/handler.js";
import type { ProxyConfigRow } from "../src/store.js";

const MASTER_KEY = randomBytes(32);

function makeConfig(over: Partial<ProxyConfigRow> = {}): ProxyConfigRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    resourceKeyId: "reskey_test",
    endpointSlug: "weather",
    publicSlug: null,
    originalUrl: "https://upstream.example.com/forecast",
    originalMethod: "POST",
    displayName: "Forecast",
    description: null,
    descriptionBazaar: null,
    priceAtomic: "100000",
    acceptedNetworks: ["eip155:8453"],
    payToEvm: "0x" + "1".repeat(40),
    payToSolana: null,
    payToCosmos: null,
    payToTron: null,
    forwardHeadersEncrypted: null,
    forwardAuthScheme: "static",
    isActive: true,
    upstreamX402Enabled: false,
    upstreamX402Network: null,
    upstreamX402MaxPrice: null,
    upstreamSignerWallet: null,
    internalHandler: null,
    mppTempoEnabled: false,
    inputSchema: null,
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
  const query = vi
    .fn()
    .mockResolvedValue({ rows: [{ id: "row_1" }], rowCount: 1 });
  return { query } as unknown as HandleDeps["pool"];
}

function facilitatorStub(url: string): Response | null {
  if (url.endsWith("/facilitator/supported")) {
    return new Response(JSON.stringify({ kinds: [] }), { status: 200 });
  }
  if (url.endsWith("/facilitator/verify")) {
    return new Response(JSON.stringify({ isValid: true, payer: "0xPAYER" }), {
      status: 200,
    });
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
  return null;
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

const PAYMENT_HEADER = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    scheme: "exact",
    network: "eip155:8453",
    payload: { signature: "0xsig", authorization: {} },
  }),
).toString("base64");

function makeArgs(over: Partial<Parameters<typeof handle>[0]> = {}) {
  return {
    resourceKeyId: "reskey_test",
    slug: "weather",
    method: "POST",
    resourceUrl: "https://proxy/v1/proxy/reskey_test/weather",
    paymentHeader: PAYMENT_HEADER,
    idempotencyKey: "idem-refund-test",
    incomingHeaders: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ zip: "94107" })),
    clientIp: "1.2.3.4",
    ...over,
  } as Parameters<typeof handle>[0];
}

function refundInserts(deps: HandleDeps) {
  const poolQuery = (
    deps.pool as unknown as { query: ReturnType<typeof vi.fn> }
  ).query;
  return poolQuery.mock.calls.filter(([sql]) =>
    String(sql).includes("INSERT INTO refunds_pending"),
  );
}

describe("handle: post-settle refund enqueue (Defect B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("settled + upstream 5xx passthrough → refunds_pending row with reason post_settle_upstream_5xx", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const fac = facilitatorStub(String(url));
      if (fac) return fac;
      if (String(url) === "https://upstream.example.com/forecast") {
        return new Response(JSON.stringify({ error: "boom" }), {
          status: 502,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const deps = makeDeps({ fetchImpl: fetchMock });
    const result = await handle(makeArgs(), deps);

    // Passthrough semantics unchanged — buyer still sees the 502 …
    expect(result.status).toBe(502);
    expect(result.outcome).toBe("settled");
    // … but the refund is now queued.
    const inserts = refundInserts(deps);
    expect(inserts.length).toBe(1);
    const params = inserts[0]![1] as unknown[];
    expect(params).toEqual(
      expect.arrayContaining([
        "post_settle_upstream_5xx",
        502,
        "0xPAYER",
        "0xTXHASH",
      ]),
    );
  });

  it("settled + upstream fetch error (our 502) → refunds_pending row with reason post_settle_unreachable", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const fac = facilitatorStub(String(url));
      if (fac) return fac;
      throw new Error("ECONNREFUSED upstream.example.com");
    });
    const deps = makeDeps({ fetchImpl: fetchMock });
    const result = await handle(makeArgs(), deps);

    expect(result.status).toBe(502);
    expect(result.outcome).toBe("upstream_error");
    const inserts = refundInserts(deps);
    expect(inserts.length).toBe(1);
    expect(inserts[0]![1]).toEqual(
      expect.arrayContaining(["post_settle_unreachable", "0xPAYER"]),
    );
  });

  it("settled + internal handler 5xx → refunds_pending row", async () => {
    // fear_greed_index GETs its upstream; making that fetch throw
    // produces the handler's own 502 — the same shape that burned
    // 0x9CC42f… on cosmos-wallet-balance.
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const fac = facilitatorStub(String(url));
      if (fac) return fac;
      throw new Error("upstream feed down");
    });
    const deps = makeDeps({
      store: makeStore(
        makeConfig({
          internalHandler: "fear_greed_index",
          originalMethod: "GET",
          originalUrl: "https://proxy.suverse.io/v1/data/fear-greed",
        }),
      ),
      fetchImpl: fetchMock,
    });
    const result = await handle(
      makeArgs({ method: "GET", body: null }),
      deps,
    );

    expect(result.status).toBeGreaterThanOrEqual(500);
    expect(result.outcome).toBe("settled");
    const inserts = refundInserts(deps);
    expect(inserts.length).toBe(1);
    expect(inserts[0]![1]).toEqual(
      expect.arrayContaining(["post_settle_upstream_5xx", "0xPAYER"]),
    );
  });

  it("settled + unknown internal handler → refunds_pending row with reason post_settle_proxy_error", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const fac = facilitatorStub(String(url));
      if (fac) return fac;
      throw new Error(`unexpected fetch: ${url}`);
    });
    const deps = makeDeps({
      store: makeStore(makeConfig({ internalHandler: "no_such_handler" })),
      fetchImpl: fetchMock,
    });
    const result = await handle(makeArgs(), deps);

    expect(result.status).toBe(503);
    const inserts = refundInserts(deps);
    expect(inserts.length).toBe(1);
    expect(inserts[0]![1]).toEqual(
      expect.arrayContaining(["post_settle_proxy_error", "0xPAYER"]),
    );
  });

  it("settled + 200 → NO refund row (control)", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const fac = facilitatorStub(String(url));
      if (fac) return fac;
      if (String(url) === "https://upstream.example.com/forecast") {
        return new Response(JSON.stringify({ temp_f: 72 }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const deps = makeDeps({ fetchImpl: fetchMock });
    const result = await handle(makeArgs(), deps);

    expect(result.status).toBe(200);
    expect(result.outcome).toBe("settled");
    expect(refundInserts(deps).length).toBe(0);
  });

  it("settled + upstream 4xx passthrough → NO refund row (buyer-input error, schema gate is the fix)", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const fac = facilitatorStub(String(url));
      if (fac) return fac;
      if (String(url) === "https://upstream.example.com/forecast") {
        return new Response(JSON.stringify({ error: "bad zip" }), {
          status: 400,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const deps = makeDeps({ fetchImpl: fetchMock });
    const result = await handle(makeArgs(), deps);

    expect(result.status).toBe(400);
    expect(result.outcome).toBe("settled");
    expect(refundInserts(deps).length).toBe(0);
  });
});
