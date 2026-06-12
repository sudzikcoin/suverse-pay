/**
 * handle() wiring tests for the per-config input-schema gate
 * (Task 57, migration 037).
 *
 * The contract under test:
 *   - schema-valid body + payment      → settles, forwards upstream
 *   - schema-invalid PRESENT body      → 422, facilitator NEVER
 *                                        consulted (no settle)
 *   - empty/placeholder body, unpaid   → 402 discovery challenge with
 *                                        input_schema attached
 *                                        (regression guard for the
 *                                        0e4ff10 crawler-visibility fix)
 *   - empty/placeholder body, PAID     → 422 before settlement
 *   - config without schema            → unchanged behavior (invalid
 *                                        body settles + forwards, the
 *                                        pre-Task-57 status quo)
 */

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handle, type HandleDeps } from "../src/handler.js";
import type { ProxyConfigRow } from "../src/store.js";

const MASTER_KEY = randomBytes(32);

const TXID_SCHEMA = {
  type: "object",
  required: ["txid"],
  properties: {
    txid: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
};

function makeConfig(over: Partial<ProxyConfigRow> = {}): ProxyConfigRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    resourceKeyId: "reskey_test",
    endpointSlug: "tx-info",
    publicSlug: null,
    originalUrl: "https://upstream.example.com/tx-info",
    originalMethod: "POST",
    displayName: "Tx info",
    description: "Upstream tx info",
    descriptionBazaar: null,
    priceAtomic: "50000",
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
    inputSchema: TXID_SCHEMA,
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
  const query = vi.fn().mockResolvedValue({ rows: [{ id: "row_1" }], rowCount: 1 });
  return { query } as unknown as HandleDeps["pool"];
}

/** Facilitator + upstream stub for the settle path. */
function makeSettleFetchMock() {
  return vi.fn().mockImplementation(async (url: string) => {
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
    if (url === "https://upstream.example.com/tx-info") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
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
    slug: "tx-info",
    method: "POST",
    resourceUrl: "https://proxy/v1/proxy/reskey_test/tx-info",
    paymentHeader: undefined,
    idempotencyKey: undefined,
    incomingHeaders: { "content-type": "application/json" },
    body: null,
    clientIp: "1.2.3.4",
    ...over,
  } as Parameters<typeof handle>[0];
}

function settleCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([u]) =>
    String(u).includes("/facilitator/"),
  );
}

describe("handle: per-config input-schema gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("schema-valid body + payment → settles and serves", async () => {
    const fetchMock = makeSettleFetchMock();
    const deps = makeDeps({ fetchImpl: fetchMock });
    const result = await handle(
      makeArgs({
        paymentHeader: PAYMENT_HEADER,
        idempotencyKey: "idem-1",
        body: Buffer.from(JSON.stringify({ txid: "a".repeat(64) })),
      }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(result.outcome).toBe("settled");
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).endsWith("/facilitator/settle")),
    ).toBe(true);
  });

  it("schema-invalid PRESENT body + payment → 422, facilitator never consulted", async () => {
    const fetchMock = makeSettleFetchMock();
    const deps = makeDeps({ fetchImpl: fetchMock });
    const result = await handle(
      makeArgs({
        paymentHeader: PAYMENT_HEADER,
        body: Buffer.from(JSON.stringify({ txid: "not-a-txid" })),
      }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.outcome).toBe("invalid_config");
    expect(result.body).toMatchObject({ error: "invalid_request_body" });
    // input_schema attached so the buyer can self-correct.
    expect(
      (result.body as Record<string, unknown>)["input_schema"],
    ).toMatchObject({ method: "POST", content_type: "application/json" });
    expect(settleCalls(fetchMock).length).toBe(0);
    // Logged as invalid_config with the schema-gate error code.
    const poolQuery = (deps.pool as unknown as { query: ReturnType<typeof vi.fn> }).query;
    const prl = poolQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO proxy_request_logs"),
    );
    expect(prl.length).toBe(1);
    expect(prl[0]![1]).toEqual(
      expect.arrayContaining(["invalid_config", "client_invalid_body_schema"]),
    );
  });

  it("schema-invalid body, unpaid → 422 before the 402 challenge", async () => {
    const fetchMock = makeSettleFetchMock();
    const deps = makeDeps({ fetchImpl: fetchMock });
    const result = await handle(
      makeArgs({ body: Buffer.from(JSON.stringify({ txid: 99 })) }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(settleCalls(fetchMock).length).toBe(0);
  });

  it("empty body, unpaid → 402 discovery challenge with input_schema (0e4ff10 regression guard)", async () => {
    const fetchMock = makeSettleFetchMock();
    const deps = makeDeps({ fetchImpl: fetchMock });
    const result = await handle(makeArgs({ body: null }), deps);
    expect(result.status).toBe(402);
    expect(result.outcome).toBe("challenge");
    const body = result.body as Record<string, unknown>;
    expect(body["input_schema"]).toMatchObject({
      method: "POST",
      content_type: "application/json",
    });
    expect(
      (body["input_schema"] as Record<string, unknown>)["body"],
    ).toMatchObject({ type: "object", required: ["txid"] });
    // Settle never ran.
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).endsWith("/facilitator/settle")),
    ).toBe(false);
  });

  it("placeholder body, unpaid → 402 discovery challenge", async () => {
    const fetchMock = makeSettleFetchMock();
    const deps = makeDeps({ fetchImpl: fetchMock });
    const result = await handle(
      makeArgs({ body: Buffer.from(JSON.stringify({ txid: "string" })) }),
      deps,
    );
    expect(result.status).toBe(402);
    expect(result.outcome).toBe("challenge");
  });

  it("empty body + PAYMENT → 422 before settlement, never charges", async () => {
    const fetchMock = makeSettleFetchMock();
    const deps = makeDeps({ fetchImpl: fetchMock });
    const result = await handle(
      makeArgs({ paymentHeader: PAYMENT_HEADER, body: Buffer.from("{}") }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.outcome).toBe("invalid_config");
    expect(result.body).toMatchObject({ error: "required_input_missing" });
    expect(settleCalls(fetchMock).length).toBe(0);
  });

  it("config WITHOUT schema keeps current behavior — invalid body settles + forwards", async () => {
    const fetchMock = makeSettleFetchMock();
    const deps = makeDeps({
      store: makeStore(makeConfig({ inputSchema: null })),
      fetchImpl: fetchMock,
    });
    const result = await handle(
      makeArgs({
        paymentHeader: PAYMENT_HEADER,
        idempotencyKey: "idem-2",
        body: Buffer.from(JSON.stringify({ txid: "garbage" })),
      }),
      deps,
    );
    // Pre-Task-57 status quo: settles, upstream decides.
    expect(result.status).toBe(200);
    expect(result.outcome).toBe("settled");
  });

  it("unusable schema value (array) is ignored — no validation", async () => {
    const fetchMock = makeSettleFetchMock();
    const deps = makeDeps({
      store: makeStore(makeConfig({ inputSchema: ["junk"] })),
      fetchImpl: fetchMock,
    });
    const result = await handle(
      makeArgs({
        paymentHeader: PAYMENT_HEADER,
        idempotencyKey: "idem-3",
        body: Buffer.from(JSON.stringify({ txid: "garbage" })),
      }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(result.outcome).toBe("settled");
  });
});
