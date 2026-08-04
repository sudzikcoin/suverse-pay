/**
 * Tests for pre-payment internal-handler validators.
 *
 * Two tracks:
 *   1. The validator functions themselves in isolation — empty body,
 *      malformed JSON, missing required field, wrong encoding,
 *      happy path.
 *   2. The wiring inside `handle()` — when a config has an
 *      `internal_handler` with a registered validator and the buyer
 *      sends a bad body, the proxy returns 400 BEFORE runProtocol
 *      runs, logs `outcome='invalid_config'` with
 *      `errorCode='client_invalid_body'`, and never hits the
 *      facilitator.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  heliusTxSimulatorPreflight,
  heliusTxSimulatorValidator,
} from "../src/handlers/helius-tx-simulator.js";
import {
  heliusTxDecoderPreflight,
  heliusTxDecoderValidator,
} from "../src/handlers/helius-tx-decoder.js";
import { handle, type HandleDeps } from "../src/handler.js";
import type { ProxyConfigRow } from "../src/store.js";

// ──────────────────────────────────────────────────────────────────
// Validator unit tests
// ──────────────────────────────────────────────────────────────────

// Decision table (see handlers/discovery.ts):
//   empty / missing / placeholder → DISCOVERY: return null so the
//     caller reaches the 402 challenge and can read `input_schema`.
//   present + valid                → null (normal paid flow).
//   unparseable JSON               → 400.
//   non-object JSON / real-but-wrong value → 422 with `expected`.
// A PAID request carrying a discovery body is stopped by the
// preflight (asserted separately below), never by settlement.

describe("heliusTxSimulatorValidator", () => {
  it("accepts a valid base64 transaction (returns null)", () => {
    const tx = Buffer.alloc(200).toString("base64"); // >100 chars, base64
    const res = heliusTxSimulatorValidator(
      Buffer.from(JSON.stringify({ transaction: tx })),
      "POST",
    );
    expect(res).toBeNull();
  });

  it("passes an empty body through to the 402 challenge", () => {
    expect(heliusTxSimulatorValidator(null, "POST")).toBeNull();
  });

  it("passes an empty buffer through to the 402 challenge", () => {
    expect(heliusTxSimulatorValidator(Buffer.from(""), "POST")).toBeNull();
  });

  it("passes `{}` through to the 402 challenge (schema-blind probe)", () => {
    expect(heliusTxSimulatorValidator(Buffer.from("{}"), "POST")).toBeNull();
  });

  it("passes a placeholder value through to the 402 challenge", () => {
    const res = heliusTxSimulatorValidator(
      Buffer.from(JSON.stringify({ transaction: "string" })),
      "POST",
    );
    expect(res).toBeNull();
  });

  it("rejects body that is not JSON", () => {
    const res = heliusTxSimulatorValidator(Buffer.from("not json"), "POST");
    expect(res?.status).toBe(400);
    expect(res?.body).toMatchObject({ error: "invalid_json_body" });
  });

  it("rejects a non-object JSON body", () => {
    const res = heliusTxSimulatorValidator(Buffer.from("[1,2]"), "POST");
    expect(res?.status).toBe(422);
    expect(res?.body).toMatchObject({ error: "transaction_required" });
  });

  it("rejects too-short transaction with 422 + expected", () => {
    const res = heliusTxSimulatorValidator(
      Buffer.from(JSON.stringify({ transaction: "AAAA" })),
      "POST",
    );
    expect(res?.status).toBe(422);
    expect(res?.body).toMatchObject({ error: "invalid_transaction_format" });
    expect(res?.body).toHaveProperty("expected");
  });

  it("rejects non-base64 transaction characters", () => {
    const bogus = "!@#$%^&*()".repeat(15); // 150 chars, none base64
    const res = heliusTxSimulatorValidator(
      Buffer.from(JSON.stringify({ transaction: bogus })),
      "POST",
    );
    expect(res?.status).toBe(422);
    expect(res?.body).toMatchObject({ error: "invalid_transaction_format" });
  });

  it("skips validation on non-POST methods (returns null)", () => {
    // GET requests have no body; the proxy will reject method
    // mismatch elsewhere if config.original_method != GET. The
    // validator's job is body shape, not method routing.
    const res = heliusTxSimulatorValidator(null, "GET");
    expect(res).toBeNull();
  });
});

describe("heliusTxDecoderValidator", () => {
  it("accepts a plausible base58 signature", () => {
    // Solana signatures are 86-88 base58 chars in practice. Pick 87.
    const sig =
      "1".repeat(87); // single-char "1" is valid base58 alphabet
    const res = heliusTxDecoderValidator(
      Buffer.from(JSON.stringify({ signature: sig })),
      "POST",
    );
    expect(res).toBeNull();
  });

  it("passes an empty body through to the 402 challenge", () => {
    expect(heliusTxDecoderValidator(null, "POST")).toBeNull();
  });

  it("passes `{}` through to the 402 challenge (schema-blind probe)", () => {
    expect(heliusTxDecoderValidator(Buffer.from("{}"), "POST")).toBeNull();
  });

  it("passes a placeholder value through to the 402 challenge", () => {
    // "abc" is conventional schema-blind filler, not a real signature.
    const res = heliusTxDecoderValidator(
      Buffer.from(JSON.stringify({ signature: "abc" })),
      "POST",
    );
    expect(res).toBeNull();
  });

  it("rejects bad JSON", () => {
    const res = heliusTxDecoderValidator(Buffer.from("xxx"), "POST");
    expect(res?.status).toBe(400);
    expect(res?.body).toMatchObject({ error: "invalid_json_body" });
  });

  it("rejects a non-object JSON body", () => {
    const res = heliusTxDecoderValidator(Buffer.from("[1,2]"), "POST");
    expect(res?.status).toBe(422);
    expect(res?.body).toMatchObject({ error: "signature_required" });
  });

  it("rejects too-long signature with 422 + expected", () => {
    const res = heliusTxDecoderValidator(
      Buffer.from(JSON.stringify({ signature: "A".repeat(200) })),
      "POST",
    );
    expect(res?.status).toBe(422);
    expect(res?.body).toMatchObject({ error: "invalid_signature_format" });
    expect(res?.body).toHaveProperty("expected");
  });

  it("rejects non-base58 characters (zero, O, I, l)", () => {
    // The 'l' character is excluded from base58.
    const res = heliusTxDecoderValidator(
      Buffer.from(JSON.stringify({ signature: "l".repeat(80) })),
      "POST",
    );
    expect(res?.status).toBe(422);
    expect(res?.body).toMatchObject({ error: "invalid_signature_format" });
  });
});

describe("helius preflights — a PAID discovery body never settles", () => {
  const paidCases: Array<[string, Buffer | null]> = [
    ["empty body", null],
    ["empty buffer", Buffer.from("")],
    ["schema-blind {}", Buffer.from("{}")],
    ["placeholder value", Buffer.from(JSON.stringify({ signature: "abc" }))],
  ];

  it.each(paidCases)(
    "decoder preflight refuses %s with 422 before settlement",
    async (_label, body) => {
      const res = await heliusTxDecoderPreflight({ body, method: "POST" });
      expect(res.proceed).toBe(false);
      if (res.proceed === false) {
        expect(res.status).toBe(422);
        expect(res.body).toHaveProperty("input_schema");
      }
    },
  );

  it("decoder preflight proceeds on a real signature", async () => {
    const res = await heliusTxDecoderPreflight({
      body: Buffer.from(JSON.stringify({ signature: "1".repeat(87) })),
      method: "POST",
    });
    expect(res.proceed).toBe(true);
  });

  it("simulator preflight refuses a paid empty body with 422", async () => {
    const res = await heliusTxSimulatorPreflight({
      body: null,
      method: "POST",
    });
    expect(res.proceed).toBe(false);
    if (res.proceed === false) expect(res.status).toBe(422);
  });

  it("simulator preflight proceeds on a real transaction", async () => {
    const res = await heliusTxSimulatorPreflight({
      body: Buffer.from(
        JSON.stringify({ transaction: Buffer.alloc(200).toString("base64") }),
      ),
      method: "POST",
    });
    expect(res.proceed).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────
// handle() wiring tests
// ──────────────────────────────────────────────────────────────────

const MASTER_KEY = randomBytes(32);

function makeConfig(over: Partial<ProxyConfigRow> = {}): ProxyConfigRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    resourceKeyId: "reskey_test",
    endpointSlug: "simulator",
    originalUrl: "https://proxy.suverse.io/v1/data/sim",
    originalMethod: "POST",
    displayName: "Simulator",
    description: null,
    descriptionBazaar: null,
    priceAtomic: "100000",
    acceptedNetworks: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
    payToEvm: null,
    payToSolana: "11111111111111111111111111111111",
    payToCosmos: null,
    payToTron: null,
    forwardHeadersEncrypted: null,
    forwardAuthScheme: "static",
    isActive: true,
    upstreamX402Enabled: false,
    upstreamX402Network: null,
    upstreamX402MaxPrice: null,
    upstreamSignerWallet: null,
    publicSlug: "suverse-solana-tx-simulator",
    internalHandler: "helius_tx_simulator",
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
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  return { query } as unknown as HandleDeps["pool"];
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

describe("handle: pre-payment validator wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves the 402 challenge for a `{}` probe on helius_tx_simulator", async () => {
    const fetchSpy = makeChallengeFetch();
    const deps = makeDeps({ fetchImpl: fetchSpy });
    const result = await handle(
      {
        resourceKeyId: "reskey_test",
        slug: "simulator",
        method: "POST",
        resourceUrl: "https://proxy/v1/data/suverse-solana-tx-simulator",
        paymentHeader: undefined,
        idempotencyKey: undefined,
        incomingHeaders: { "content-type": "application/json" },
        body: Buffer.from("{}"),
        clientIp: "1.2.3.4",
      },
      deps,
    );

    // A schema-blind `{}` probe is DISCOVERY: it must reach the 402 so
    // the crawler can read price + input_schema. Before 2026-08-04 this
    // returned 400 and the endpoint stayed invisible to discovery.
    expect(result.status).toBe(402);
    expect(result.outcome).toBe("challenge");
    expect(result.body).toHaveProperty("input_schema");
    // No `client_invalid_body` rejection row is written any more.
    const poolQuery = (deps.pool as unknown as { query: ReturnType<typeof vi.fn> })
      .query;
    const rejectRows = poolQuery.mock.calls.filter(
      ([sql, params]) =>
        String(sql).includes("INSERT INTO proxy_request_logs") &&
        Array.isArray(params) &&
        params.includes("client_invalid_body"),
    );
    expect(rejectRows.length).toBe(0);
  });

  it("rejects garbage JSON BEFORE 402 for helius_tx_simulator", async () => {
    const fetchSpy = vi.fn();
    const deps = makeDeps({ fetchImpl: fetchSpy });
    const result = await handle(
      {
        resourceKeyId: "reskey_test",
        slug: "simulator",
        method: "POST",
        resourceUrl: "https://proxy/v1/data/suverse-solana-tx-simulator",
        paymentHeader: undefined,
        idempotencyKey: undefined,
        incomingHeaders: { "content-type": "application/json" },
        body: Buffer.from("not json at all"),
        clientIp: "1.2.3.4",
      },
      deps,
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: "invalid_json_body" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves the 402 challenge when `signature` is absent (helius_tx_decoder)", async () => {
    const fetchSpy = makeChallengeFetch();
    const deps = makeDeps({
      store: makeStore(
        makeConfig({
          internalHandler: "helius_tx_decoder",
          publicSlug: "suverse-solana-tx-decoder",
        }),
      ),
      fetchImpl: fetchSpy,
    });
    const result = await handle(
      {
        resourceKeyId: "reskey_test",
        slug: "simulator",
        method: "POST",
        resourceUrl: "https://proxy/v1/data/suverse-solana-tx-decoder",
        paymentHeader: undefined,
        idempotencyKey: undefined,
        incomingHeaders: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ wrong_field: "x" })),
        clientIp: "1.2.3.4",
      },
      deps,
    );

    // No usable `signature` supplied → DISCOVERY, not a malformed
    // attempt: serve the 402 so the caller learns the real contract.
    expect(result.status).toBe(402);
    expect(result.outcome).toBe("challenge");
    expect(result.body).toHaveProperty("input_schema");
  });

  it("still 422s a real-but-wrong signature BEFORE the 402", async () => {
    const fetchSpy = makeChallengeFetch();
    const deps = makeDeps({
      store: makeStore(
        makeConfig({
          internalHandler: "helius_tx_decoder",
          publicSlug: "suverse-solana-tx-decoder",
        }),
      ),
      fetchImpl: fetchSpy,
    });
    const result = await handle(
      {
        resourceKeyId: "reskey_test",
        slug: "simulator",
        method: "POST",
        resourceUrl: "https://proxy/v1/data/suverse-solana-tx-decoder",
        paymentHeader: undefined,
        idempotencyKey: undefined,
        incomingHeaders: { "content-type": "application/json" },
        // 'l' is outside the base58 alphabet — a real, wrong value.
        body: Buffer.from(JSON.stringify({ signature: "l".repeat(80) })),
        clientIp: "1.2.3.4",
      },
      deps,
    );

    expect(result.status).toBe(422);
    expect(result.outcome).toBe("invalid_config");
    expect(result.body).toMatchObject({ error: "invalid_signature_format" });
  });

  it("passes a valid body through to runProtocol (no early 400)", async () => {
    // Stub fetch so that runProtocol's facilitator probe yields a 402
    // challenge. We don't care about the actual challenge body — only
    // that the validator did NOT short-circuit.
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/facilitator/supported")) {
        return Promise.resolve(
          new Response(JSON.stringify({ kinds: [] }), { status: 200 }),
        );
      }
      // Default: anything else gets a generic 200 — runProtocol will
      // build its 402 from acceptedPayments without calling out.
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;
    const deps = makeDeps({ fetchImpl: fetchSpy });

    // A valid base64 transaction body (200 base64-safe chars).
    const validTx = Buffer.alloc(200).toString("base64");
    const result = await handle(
      {
        resourceKeyId: "reskey_test",
        slug: "simulator",
        method: "POST",
        resourceUrl: "https://proxy/v1/data/suverse-solana-tx-simulator",
        paymentHeader: undefined,
        idempotencyKey: undefined,
        incomingHeaders: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ transaction: validTx })),
        clientIp: "1.2.3.4",
      },
      deps,
    );

    // runProtocol returns 402 challenge because no X-Payment header.
    // Critically NOT 400 → validator passed.
    expect(result.status).toBe(402);
    expect(result.outcome).toBe("challenge");
  });
});

// ──────────────────────────────────────────────────────────────────
// Discovery split — catalog crawlers probing with empty/placeholder
// bodies must reach the 402 challenge (with `input_schema`), while a
// present-but-invalid base58 value stays a pre-challenge 422 that
// never settles. (morning-report 20260612: crawler 0x9CC42f hit 422
// before the 402 on wallet-reputation/token-check → invisible in
// Bazaar discovery.)
// ──────────────────────────────────────────────────────────────────

function makeChallengeFetch() {
  return vi.fn().mockImplementation((url: string) => {
    const u = String(url);
    if (u.endsWith("/facilitator/supported")) {
      return Promise.resolve(
        new Response(JSON.stringify({ kinds: [] }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;
}

function walletRepDeps(over: Partial<HandleDeps> = {}) {
  return makeDeps({
    store: makeStore(
      makeConfig({
        internalHandler: "wallet_reputation",
        publicSlug: "suverse-wallet-reputation",
      }),
    ),
    fetchImpl: makeChallengeFetch(),
    ...over,
  });
}

async function callWalletRep(deps: HandleDeps, body: Buffer | null) {
  return handle(
    {
      resourceKeyId: "reskey_test",
      slug: "simulator",
      method: "POST",
      resourceUrl: "https://proxy/v1/data/suverse-wallet-reputation",
      paymentHeader: undefined,
      idempotencyKey: undefined,
      incomingHeaders: { "content-type": "application/json" },
      body,
      clientIp: "1.2.3.4",
    },
    deps,
  );
}

describe("handle: discovery probes reach the 402 challenge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["empty body", null],
    ["empty object", Buffer.from("{}")],
    ["placeholder wallet", Buffer.from(JSON.stringify({ wallet: "string" }))],
    [
      "angle-bracket placeholder",
      Buffer.from(JSON.stringify({ wallet: "<solana base58 address>" })),
    ],
  ])(
    "wallet_reputation: %s -> 402 challenge with input_schema",
    async (_label, body) => {
      const deps = walletRepDeps();
      const result = await callWalletRep(deps, body);
      expect(result.status).toBe(402);
      expect(result.outcome).toBe("challenge");
      const challenge = result.body as Record<string, any>;
      // Machine-readable contract the crawler/agent can read.
      expect(challenge["input_schema"]).toBeDefined();
      expect(challenge["input_schema"]["body"]["required"]).toEqual(["wallet"]);
      expect(typeof challenge["input_schema"]["example"]["wallet"]).toBe(
        "string",
      );
      // The same augmented JSON rides the payment-required header.
      const headerJson = JSON.parse(
        Buffer.from(
          result.headers!["payment-required"]!,
          "base64",
        ).toString("utf8"),
      ) as Record<string, unknown>;
      expect(headerJson["input_schema"]).toBeDefined();
    },
  );

  it("token_check: empty body -> 402 challenge with input_schema", async () => {
    const deps = makeDeps({
      store: makeStore(
        makeConfig({
          internalHandler: "token_check",
          publicSlug: "suverse-token-check",
        }),
      ),
      fetchImpl: makeChallengeFetch(),
    });
    const result = await handle(
      {
        resourceKeyId: "reskey_test",
        slug: "simulator",
        method: "POST",
        resourceUrl: "https://proxy/v1/data/suverse-token-check",
        paymentHeader: undefined,
        idempotencyKey: undefined,
        incomingHeaders: { "content-type": "application/json" },
        body: null,
        clientIp: "1.2.3.4",
      },
      deps,
    );
    expect(result.status).toBe(402);
    expect(result.outcome).toBe("challenge");
    const challenge = result.body as Record<string, any>;
    expect(challenge["input_schema"]["body"]["required"]).toEqual(["token"]);
  });

  it("wallet_reputation: present-but-invalid base58 -> 422, no settle attempt", async () => {
    const fetchSpy = vi.fn();
    const deps = walletRepDeps({ fetchImpl: fetchSpy as unknown as typeof fetch });
    const result = await callWalletRep(
      deps,
      Buffer.from(JSON.stringify({ wallet: "0xdeadbeef-not-base58" })),
    );
    expect(result.status).toBe(422);
    expect(result.outcome).toBe("invalid_config");
    expect(result.body).toMatchObject({ error: "invalid_wallet_address" });
    // Facilitator never consulted — nothing could possibly settle.
    expect(fetchSpy).not.toHaveBeenCalled();
    const poolQuery = (deps.pool as unknown as { query: ReturnType<typeof vi.fn> })
      .query;
    const prlInserts = poolQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO proxy_request_logs"),
    );
    expect(prlInserts.length).toBe(1);
    expect(prlInserts[0]![1]).toEqual(
      expect.arrayContaining(["invalid_config", "client_invalid_body"]),
    );
  });

  it("crypto_market_pulse (no required input): challenge body untouched", async () => {
    const deps = makeDeps({
      store: makeStore(
        makeConfig({
          internalHandler: "crypto_market_pulse",
          publicSlug: "suverse-crypto-market-pulse",
        }),
      ),
      fetchImpl: makeChallengeFetch(),
    });
    const result = await handle(
      {
        resourceKeyId: "reskey_test",
        slug: "simulator",
        method: "POST",
        resourceUrl: "https://proxy/v1/data/suverse-crypto-market-pulse",
        paymentHeader: undefined,
        idempotencyKey: undefined,
        incomingHeaders: { "content-type": "application/json" },
        body: null,
        clientIp: "1.2.3.4",
      },
      deps,
    );
    expect(result.status).toBe(402);
    expect(
      (result.body as Record<string, unknown>)["input_schema"],
    ).toBeUndefined();
  });
});
