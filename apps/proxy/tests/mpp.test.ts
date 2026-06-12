/**
 * MPP/Tempo rail tests (Task 39a-rescoped).
 *
 * Handler-level coverage uses a FAKE MppRail injected through
 * HandleDeps — no chain, no mppx internals — and asserts the gating
 * matrix, the additive WWW-Authenticate challenge, the
 * Authorization: Payment settle path (which must bypass the x402
 * facilitator entirely), and failure semantics.
 *
 * Rail-level coverage exercises the REAL mppx-backed MppTempoRail
 * for everything that runs locally: challenge generation (stateless
 * HMAC — no network), header round-tripping, and credential
 * rejection. On-chain settlement is covered by the live testnet
 * smoke script, not unit tests.
 */

import { randomBytes } from "node:crypto";
import { Challenge } from "mppx";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handle, type HandleDeps } from "../src/handler.js";
import {
  atomicToHuman,
  isMppAuthorization,
  loadMppRail,
  MppTempoRail,
  TEMPO_NETWORKS,
  type MppRail,
} from "../src/mpp.js";
import type { ProxyConfigRow } from "../src/store.js";

const MASTER_KEY = randomBytes(32);
const SECRET = "unit-test-secret-key-0123456789abcdef";

function makeConfig(over: Partial<ProxyConfigRow> = {}): ProxyConfigRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    resourceKeyId: "reskey_test",
    endpointSlug: "weather",
    originalUrl: "https://upstream.example.com/forecast",
    originalMethod: "POST",
    displayName: "Forecast",
    description: "Weather forecast",
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
    publicSlug: null,
    internalHandler: null,
    mppTempoEnabled: false,
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

function makeRail(over: Partial<MppRail> = {}): MppRail {
  return {
    network: "eip155:42431",
    asset: TEMPO_NETWORKS.testnet.currency,
    challengeHeader: vi
      .fn()
      .mockResolvedValue('Payment id="fake", realm="proxy.suverse.io", method="tempo"'),
    verifyAndSettle: vi.fn().mockResolvedValue({
      ok: true,
      txHash: "0x" + "ab".repeat(32),
      payer: "0x" + "2".repeat(40),
      receiptHeader: "Payment fake-receipt",
    }),
    ...over,
  };
}

/** fetch stub satisfying the facilitator discover + health probe. */
function makeChallengeFetch() {
  return vi.fn().mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.endsWith("/facilitator/supported")) {
      return new Response(JSON.stringify({ kinds: [] }), { status: 200 });
    }
    if (url === "https://upstream.example.com/forecast" && init?.method === "HEAD") {
      return new Response(null, { status: 200 });
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
    fetchImpl: makeChallengeFetch(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
}

function makeArgs(over: Partial<Parameters<typeof handle>[0]> = {}) {
  return {
    resourceKeyId: "reskey_test",
    slug: "weather",
    method: "POST",
    resourceUrl: "https://proxy/v1/proxy/reskey_test/weather",
    paymentHeader: undefined,
    idempotencyKey: undefined,
    incomingHeaders: {},
    body: null,
    clientIp: "1.2.3.4",
    ...over,
  };
}

describe("atomicToHuman", () => {
  it("converts 6-dp atomic to human", () => {
    expect(atomicToHuman("50000", 6)).toBe("0.05");
    expect(atomicToHuman("1000000", 6)).toBe("1");
    expect(atomicToHuman("1", 6)).toBe("0.000001");
    expect(atomicToHuman("0", 6)).toBe("0");
    expect(atomicToHuman("1230000", 6)).toBe("1.23");
  });
  it("throws on non-integer input", () => {
    expect(() => atomicToHuman("0.05", 6)).toThrow();
    expect(() => atomicToHuman("nope", 6)).toThrow();
  });
});

describe("isMppAuthorization", () => {
  it("matches the Payment scheme case-insensitively", () => {
    expect(isMppAuthorization("Payment eyJabc")).toBe(true);
    expect(isMppAuthorization("payment eyJabc")).toBe(true);
    expect(isMppAuthorization("PAYMENT eyJabc")).toBe(true);
  });
  it("rejects other schemes and junk", () => {
    expect(isMppAuthorization(undefined)).toBe(false);
    expect(isMppAuthorization("")).toBe(false);
    expect(isMppAuthorization("Bearer abc")).toBe(false);
    expect(isMppAuthorization("Basic dXNlcjpwdw==")).toBe(false);
    expect(isMppAuthorization("Payment")).toBe(false);
    expect(isMppAuthorization("Payments eyJabc")).toBe(false);
  });
});

describe("loadMppRail", () => {
  it("returns undefined when MPP_TEMPO_ENABLED is unset", () => {
    expect(loadMppRail({})).toBeUndefined();
    expect(loadMppRail({ MPP_SECRET_KEY: SECRET })).toBeUndefined();
  });
  it("returns undefined (and logs) when the secret is missing or short", () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(loadMppRail({ MPP_TEMPO_ENABLED: "true" }, log)).toBeUndefined();
    expect(
      loadMppRail({ MPP_TEMPO_ENABLED: "true", MPP_SECRET_KEY: "short" }, log),
    ).toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(2);
  });
  it("returns undefined on an unknown network name", () => {
    expect(
      loadMppRail({
        MPP_TEMPO_ENABLED: "true",
        MPP_SECRET_KEY: SECRET,
        MPP_TEMPO_NETWORK: "devnet",
      }),
    ).toBeUndefined();
  });
  it("builds a testnet rail by default and mainnet on request", () => {
    const testnet = loadMppRail({
      MPP_TEMPO_ENABLED: "true",
      MPP_SECRET_KEY: SECRET,
    });
    expect(testnet?.network).toBe("eip155:42431");
    const mainnet = loadMppRail({
      MPP_TEMPO_ENABLED: "true",
      MPP_SECRET_KEY: SECRET,
      MPP_TEMPO_NETWORK: "mainnet",
    });
    expect(mainnet?.network).toBe("eip155:4217");
    expect(mainnet?.asset).toBe(TEMPO_NETWORKS.mainnet.currency);
  });
});

describe("handle() MPP challenge gating", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adds WWW-Authenticate next to the x402 402 when all gates pass", async () => {
    const rail = makeRail();
    const deps = makeDeps({
      store: makeStore(makeConfig({ mppTempoEnabled: true, publicSlug: "weather-pub" })),
      mppRail: rail,
    });
    const result = await handle(makeArgs(), deps);
    expect(result.status).toBe(402);
    expect(result.outcome).toBe("challenge");
    // x402 challenge untouched…
    expect((result.body as { accepts: unknown[] }).accepts.length).toBe(1);
    expect(result.headers["payment-required"]).toMatch(/^[A-Za-z0-9+/=]+$/);
    // …MPP challenge additive, in headers only.
    expect(result.headers["www-authenticate"]).toContain('method="tempo"');
    expect(rail.challengeHeader).toHaveBeenCalledWith({
      amountAtomic: "50000",
      recipient: "0x" + "1".repeat(40),
      scope: "weather-pub", // public_slug wins over endpoint_slug
      description: "Forecast",
    });
  });

  it("emits NO MPP challenge when the row flag is off", async () => {
    const rail = makeRail();
    const deps = makeDeps({ store: makeStore(makeConfig()), mppRail: rail });
    const result = await handle(makeArgs(), deps);
    expect(result.status).toBe(402);
    expect(result.headers["www-authenticate"]).toBeUndefined();
    expect(rail.challengeHeader).not.toHaveBeenCalled();
  });

  it("emits NO MPP challenge when the row has no pay_to_evm", async () => {
    const rail = makeRail();
    const deps = makeDeps({
      store: makeStore(
        makeConfig({
          mppTempoEnabled: true,
          payToEvm: null,
          acceptedNetworks: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
          payToSolana: "CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM",
        }),
      ),
      mppRail: rail,
    });
    const result = await handle(makeArgs(), deps);
    expect(result.status).toBe(402);
    expect(result.headers["www-authenticate"]).toBeUndefined();
    expect(rail.challengeHeader).not.toHaveBeenCalled();
  });

  it("emits NO MPP challenge when no rail is configured (process gate)", async () => {
    const deps = makeDeps({
      store: makeStore(makeConfig({ mppTempoEnabled: true })),
    });
    const result = await handle(makeArgs(), deps);
    expect(result.status).toBe(402);
    expect(result.headers["www-authenticate"]).toBeUndefined();
  });

  it("still serves the x402 402 when MPP challenge generation throws", async () => {
    const rail = makeRail({
      challengeHeader: vi.fn().mockRejectedValue(new Error("hmac boom")),
    });
    const deps = makeDeps({
      store: makeStore(makeConfig({ mppTempoEnabled: true })),
      mppRail: rail,
    });
    const result = await handle(makeArgs(), deps);
    expect(result.status).toBe(402);
    expect(result.outcome).toBe("challenge");
    expect(result.headers["payment-required"]).toBeDefined();
    expect(result.headers["www-authenticate"]).toBeUndefined();
  });
});

describe("handle() MPP credential settle", () => {
  beforeEach(() => vi.clearAllMocks());

  function settleFetch() {
    // ONLY the upstream POST may be fetched: no facilitator verify/
    // settle (MPP bypasses it) and no HEAD health probe (an MPP
    // credential counts as payment).
    return vi.fn().mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === "https://upstream.example.com/forecast" && init?.method === "POST") {
        return new Response(JSON.stringify({ forecast: "sunny" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
    });
  }

  it("verifies, settles on Tempo, forwards upstream, attaches receipt headers", async () => {
    const rail = makeRail();
    const pool = makePool();
    const fetchMock = settleFetch();
    const deps = makeDeps({
      store: makeStore(makeConfig({ mppTempoEnabled: true })),
      mppRail: rail,
      pool,
      fetchImpl: fetchMock,
    });
    const result = await handle(
      makeArgs({ incomingHeaders: { authorization: "Payment eyJfake" } }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(result.outcome).toBe("settled");
    expect(rail.verifyAndSettle).toHaveBeenCalledWith("Payment eyJfake", {
      amountAtomic: "50000",
      recipient: "0x" + "1".repeat(40),
      scope: "weather",
      description: "Forecast",
    });
    // Spec receipt header + the x402-shaped payment-response pair.
    expect(result.headers["payment-receipt"]).toBe("Payment fake-receipt");
    const pr = JSON.parse(
      Buffer.from(result.headers["payment-response"]!, "base64").toString("utf8"),
    ) as { success: boolean; network: string; transaction: string; payer: string };
    expect(pr.success).toBe(true);
    expect(pr.network).toBe("eip155:42431");
    expect(pr.transaction).toBe("0x" + "ab".repeat(32));
    expect(pr.payer).toBe("0x" + "2".repeat(40));
    // x402 facilitator never contacted.
    for (const call of fetchMock.mock.calls as [string][]) {
      expect(call[0]).not.toContain("fac.example.com");
    }
    // Settled row in proxy_request_logs, but NO facilitator_payments
    // fallback (MPP has no facilitator).
    const sqls = (pool.query as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => String(c[0]),
    );
    expect(sqls.some((s) => s.includes("proxy_request_logs"))).toBe(true);
    expect(sqls.some((s) => s.includes("facilitator_payments"))).toBe(false);
  });

  it("ignores Authorization: Payment when the row flag is off (header passthrough as before)", async () => {
    const rail = makeRail();
    const deps = makeDeps({
      store: makeStore(makeConfig()),
      mppRail: rail,
    });
    // No x402 payment header either → this must be a plain 402
    // challenge; the MPP credential on a non-gated row is ignored.
    const result = await handle(
      makeArgs({ incomingHeaders: { authorization: "Payment eyJfake" } }),
      deps,
    );
    expect(result.status).toBe(402);
    expect(result.outcome).toBe("challenge");
    expect(rail.verifyAndSettle).not.toHaveBeenCalled();
  });

  it("returns 402 + fresh MPP challenge when verification fails", async () => {
    const rail = makeRail({
      verifyAndSettle: vi.fn().mockResolvedValue({
        ok: false,
        errorCode: "mpp_verificationfailed",
        message: "Transaction hash has already been used.",
      }),
    });
    const pool = makePool();
    const deps = makeDeps({
      store: makeStore(makeConfig({ mppTempoEnabled: true })),
      mppRail: rail,
      pool,
      fetchImpl: vi.fn(), // nothing may be fetched on this path
    });
    const result = await handle(
      makeArgs({ incomingHeaders: { authorization: "Payment eyJreplayed" } }),
      deps,
    );
    expect(result.status).toBe(402);
    expect(result.outcome).toBe("settle_failed");
    expect(result.body).toMatchObject({
      error: "mpp_payment_failed",
      code: "mpp_verificationfailed",
    });
    // Re-challenge so a well-behaved buyer can retry.
    expect(result.headers["www-authenticate"]).toContain('method="tempo"');
    // No x402 challenge body on the MPP rail's failure response.
    expect(result.headers["payment-required"]).toBeUndefined();
    expect((deps.fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    const sqls = (pool.query as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => String(c[0]),
    );
    expect(sqls.some((s) => s.includes("proxy_request_logs"))).toBe(true);
  });
});

describe("MppTempoRail (real mppx, local-only operations)", () => {
  const rail = new MppTempoRail({
    secretKey: SECRET,
    realm: "proxy.suverse.io",
    network: "testnet",
  });

  it("exposes the testnet CAIP-2 + pathUSD asset", () => {
    expect(rail.network).toBe("eip155:42431");
    expect(rail.asset).toBe("0x20c0000000000000000000000000000000000000");
  });

  it("generates a deserializable tempo/charge challenge with atomic amount + pinned terms", async () => {
    const header = await rail.challengeHeader({
      amountAtomic: "50000",
      recipient: "0x000000000000000000000000000000000000dEaD",
      scope: "token-check",
      description: "Token safety verdict",
    });
    expect(header.startsWith("Payment ")).toBe(true);
    const challenge = Challenge.deserialize(header) as {
      method: string;
      intent: string;
      realm: string;
      request: {
        amount: string;
        currency: string;
        recipient: string;
        methodDetails: { chainId: number };
      };
    };
    expect(challenge.method).toBe("tempo");
    expect(challenge.intent).toBe("charge");
    expect(challenge.realm).toBe("proxy.suverse.io");
    expect(challenge.request.amount).toBe("50000"); // 0.05 re-atomized
    expect(challenge.request.currency).toBe(
      "0x20c0000000000000000000000000000000000000",
    );
    expect(challenge.request.recipient).toBe(
      "0x000000000000000000000000000000000000dEaD",
    );
    expect(challenge.request.methodDetails.chainId).toBe(42431);
  });

  it("rejects garbage credentials without throwing", async () => {
    const result = await rail.verifyAndSettle("Payment bm90LWEtY3JlZGVudGlhbA", {
      amountAtomic: "50000",
      recipient: "0x000000000000000000000000000000000000dEaD",
      scope: "token-check",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode.startsWith("mpp_")).toBe(true);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// MPP × Task 57 interactions. The input-schema gate (mig 037) and the
// post-settle refund funnel landed AFTER the rail shipped (955d10c)
// and rewrote handle() around it — these tests pin the contracts the
// rail must keep: the schema gate runs BEFORE verifyAndSettle (an MPP
// credential counts as payment for the decision table), and an MPP
// settle whose response then fails 5xx enqueues a refund exactly like
// an x402 settle does.
// ─────────────────────────────────────────────────────────────────────

const TXID_SCHEMA = {
  type: "object",
  required: ["txid"],
  properties: { txid: { type: "string", pattern: "^[0-9a-f]{64}$" } },
};

function refundInserts(deps: HandleDeps) {
  const poolQuery = (deps.pool as unknown as { query: ReturnType<typeof vi.fn> }).query;
  return poolQuery.mock.calls.filter(([sql]) =>
    String(sql).includes("INSERT INTO refunds_pending"),
  );
}

describe("MPP × input-schema gate (Task 57)", () => {
  beforeEach(() => vi.clearAllMocks());

  function schemaConfig(over: Partial<ProxyConfigRow> = {}): ProxyConfigRow {
    return makeConfig({ mppTempoEnabled: true, inputSchema: TXID_SCHEMA, ...over });
  }

  it("empty body + MPP credential → 422 BEFORE verifyAndSettle (never charges)", async () => {
    const rail = makeRail();
    const fetchSpy = vi.fn(); // nothing may be fetched at all
    const deps = makeDeps({
      store: makeStore(schemaConfig()),
      mppRail: rail,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const result = await handle(
      makeArgs({
        incomingHeaders: { authorization: "Payment fake-credential" },
        body: null,
      }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.outcome).toBe("invalid_config");
    expect(result.body).toMatchObject({ error: "required_input_missing" });
    expect(rail.verifyAndSettle).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("schema-invalid body + MPP credential → 422 BEFORE verifyAndSettle", async () => {
    const rail = makeRail();
    const deps = makeDeps({
      store: makeStore(schemaConfig()),
      mppRail: rail,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    const result = await handle(
      makeArgs({
        incomingHeaders: { authorization: "Payment fake-credential" },
        body: Buffer.from(JSON.stringify({ txid: "not-hex" })),
      }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ error: "invalid_request_body" });
    expect(rail.verifyAndSettle).not.toHaveBeenCalled();
  });

  it("schema-valid body + MPP credential → settles and serves", async () => {
    const rail = makeRail();
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === "https://upstream.example.com/forecast" && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const deps = makeDeps({
      store: makeStore(schemaConfig()),
      mppRail: rail,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const result = await handle(
      makeArgs({
        incomingHeaders: { authorization: "Payment fake-credential" },
        body: Buffer.from(JSON.stringify({ txid: "a".repeat(64) })),
      }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(result.outcome).toBe("settled");
    expect(rail.verifyAndSettle).toHaveBeenCalledTimes(1);
    expect(result.headers["payment-receipt"]).toBe("Payment fake-receipt");
  });

  it("unpaid empty body on an MPP row → 402 with BOTH the MPP header and input_schema", async () => {
    const rail = makeRail();
    const deps = makeDeps({
      store: makeStore(schemaConfig()),
      mppRail: rail,
    });
    const result = await handle(makeArgs({ body: null }), deps);
    expect(result.status).toBe(402);
    expect(result.outcome).toBe("challenge");
    expect(result.headers["www-authenticate"]).toContain("Payment");
    expect(
      (result.body as Record<string, unknown>)["input_schema"],
    ).toMatchObject({ method: "POST" });
    expect(rail.verifyAndSettle).not.toHaveBeenCalled();
  });
});

describe("MPP settle × post-settle refund funnel (Task 57 Defect B)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("settled via MPP + upstream 5xx passthrough → refunds_pending row on the Tempo network", async () => {
    const rail = makeRail();
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === "https://upstream.example.com/forecast" && init?.method === "POST") {
        return new Response(JSON.stringify({ error: "boom" }), { status: 502 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const deps = makeDeps({
      store: makeStore(makeConfig({ mppTempoEnabled: true })),
      mppRail: rail,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const result = await handle(
      makeArgs({
        incomingHeaders: { authorization: "Payment fake-credential" },
        body: Buffer.from("{}"),
      }),
      deps,
    );
    expect(result.status).toBe(502);
    expect(result.outcome).toBe("settled");
    const inserts = refundInserts(deps);
    expect(inserts.length).toBe(1);
    const params = inserts[0]![1] as unknown[];
    expect(params).toEqual(
      expect.arrayContaining([
        "post_settle_upstream_5xx",
        502,
        // buyer identity from the MPP receipt, network = Tempo CAIP-2
        "0x" + "2".repeat(40),
        "eip155:42431",
        "0x" + "ab".repeat(32),
      ]),
    );
  });

  it("settled via MPP + upstream fetch error → refunds_pending row (post_settle_unreachable)", async () => {
    const rail = makeRail();
    const fetchMock = vi.fn().mockImplementation(async () => {
      throw new Error("ECONNREFUSED upstream");
    });
    const deps = makeDeps({
      store: makeStore(makeConfig({ mppTempoEnabled: true })),
      mppRail: rail,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const result = await handle(
      makeArgs({
        incomingHeaders: { authorization: "Payment fake-credential" },
        body: Buffer.from("{}"),
      }),
      deps,
    );
    expect(result.status).toBe(502);
    expect(result.outcome).toBe("upstream_error");
    const inserts = refundInserts(deps);
    expect(inserts.length).toBe(1);
    expect(inserts[0]![1]).toEqual(
      expect.arrayContaining(["post_settle_unreachable", "eip155:42431"]),
    );
  });

  it("settled via MPP + upstream 200 → NO refund row (control)", async () => {
    const rail = makeRail();
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === "https://upstream.example.com/forecast" && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const deps = makeDeps({
      store: makeStore(makeConfig({ mppTempoEnabled: true })),
      mppRail: rail,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const result = await handle(
      makeArgs({
        incomingHeaders: { authorization: "Payment fake-credential" },
        body: Buffer.from("{}"),
      }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(refundInserts(deps).length).toBe(0);
  });
});
