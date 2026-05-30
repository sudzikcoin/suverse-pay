import type { SettleRequest, VerifyRequest } from "@suverse-pay/core-types";
import { ProviderError } from "@suverse-pay/core-types";
import { describe, expect, it, vi } from "vitest";
import { CosmosPayAdapter } from "./adapter.js";
import type { CosmosPayLogger } from "./error-map.js";

interface FetchCall {
  url: string;
  init: RequestInit;
  body: unknown;
}

interface FetchScript {
  responses: ReadonlyArray<Response | Error>;
}

function makeFetch(script: FetchScript): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const rawBody = init?.body;
    const body =
      typeof rawBody === "string" ? (JSON.parse(rawBody) as unknown) : undefined;
    calls.push({ url, init: init ?? {}, body });
    if (i >= script.responses.length) {
      throw new Error(`fetch called more times than scripted (i=${i})`);
    }
    const next = script.responses[i++]!;
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

function makeAdapter(overrides: {
  fetch: typeof globalThis.fetch;
  logger?: CosmosPayLogger;
}): CosmosPayAdapter {
  return new CosmosPayAdapter({
    baseUrl: "https://cosmos-pay.test/",
    networkAssets: {
      "cosmos:noble-1": ["uusdc"],
      "cosmos:grand-1": ["uusdc"],
    },
    estimatedFeeUsd: "0.0001",
    fetchImpl: overrides.fetch,
    ...(overrides.logger !== undefined ? { logger: overrides.logger } : {}),
  });
}

const verifyReq: VerifyRequest = {
  paymentPayload: {
    x402Version: 2,
    scheme: "exact_cosmos_authz",
    network: "cosmos:noble-1",
    payload: {
      from: "noble1payer",
      publicKey: "AgX",
      signature: "MEU",
      authorization: {
        from: "noble1payer",
        to: "noble1recipient",
        denom: "uusdc",
        amount: "10000",
        nonce: "0x" + "ab".repeat(32),
        validAfter: 1_716_700_000,
        validBefore: 1_716_700_060,
        resource: "https://api.example.test/x",
        chainId: "noble-1",
      },
    },
  },
  paymentRequirements: {
    scheme: "exact_cosmos_authz",
    network: "cosmos:noble-1",
    maxAmountRequired: "10000",
    asset: "uusdc",
    payTo: "noble1recipient",
    resource: "https://api.example.test/x",
    maxTimeoutSeconds: 60,
    extra: {
      facilitator: "noble1facilitator",
      chainId: "noble-1",
      decimals: 6,
      symbol: "USDC",
    },
  },
};

const settleReq: SettleRequest = verifyReq;

describe("CosmosPayAdapter basics", () => {
  it("exposes id + displayName", () => {
    const { fetch } = makeFetch({ responses: [] });
    const a = makeAdapter({ fetch });
    expect(a.id).toBe("cosmos-pay");
    expect(a.displayName).toBe("Suverse Cosmos Facilitator");
  });

  it("supports(): exact match for configured (network, asset, scheme)", async () => {
    const { fetch } = makeFetch({ responses: [] });
    const a = makeAdapter({ fetch });
    expect(
      await a.supports({
        network: "cosmos:noble-1",
        asset: "uusdc",
        scheme: "exact_cosmos_authz",
      }),
    ).toEqual({ supported: true });
  });

  it("supports(): rejects with reason on wrong scheme", async () => {
    const { fetch } = makeFetch({ responses: [] });
    const a = makeAdapter({ fetch });
    expect(
      await a.supports({
        network: "cosmos:noble-1",
        asset: "uusdc",
        scheme: "exact_evm",
      }),
    ).toEqual({ supported: false, reason: "unsupported_scheme" });
  });

  it("supports(): rejects unknown network", async () => {
    const { fetch } = makeFetch({ responses: [] });
    const a = makeAdapter({ fetch });
    expect(
      (await a.supports({
        network: "cosmos:osmosis-1",
        asset: "uusdc",
        scheme: "exact_cosmos_authz",
      })).supported,
    ).toBe(false);
  });

  it("supports(): rejects asset that isn't configured for the network", async () => {
    const { fetch } = makeFetch({ responses: [] });
    const a = makeAdapter({ fetch });
    expect(
      (await a.supports({
        network: "cosmos:noble-1",
        asset: "uatom",
        scheme: "exact_cosmos_authz",
      })).supported,
    ).toBe(false);
  });

  it("quote(): synthetic, returns configured fee", async () => {
    const { fetch } = makeFetch({ responses: [] });
    const a = makeAdapter({ fetch });
    const q = await a.quote({
      network: "cosmos:noble-1",
      asset: "uusdc",
      amount: "10000",
      scheme: "exact_cosmos_authz",
    });
    expect(q.source).toBe("synthetic");
    expect(q.estimatedFeeUsd).toBe("0.0001");
    expect(q.providerId).toBe("cosmos-pay");
  });
});

describe("CosmosPayAdapter /verify", () => {
  it("happy path: parses isValid + payer", async () => {
    const { fetch, calls } = makeFetch({
      responses: [jsonResponse({ isValid: true, payer: "noble1payer" })],
    });
    const a = makeAdapter({ fetch });
    const result = await a.verify(verifyReq);
    expect(result.valid).toBe(true);
    expect(result.payer).toBe("noble1payer");
    expect(result.providerId).toBe("cosmos-pay");
    expect(calls[0]!.url).toBe("https://cosmos-pay.test/verify");
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("forwards a properly-shaped cosmos-pay VerifyRequest body", async () => {
    const { fetch, calls } = makeFetch({
      responses: [jsonResponse({ isValid: true, payer: "noble1payer" })],
    });
    const a = makeAdapter({ fetch });
    await a.verify(verifyReq);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body).toHaveProperty("x402Version", 2);
    expect(body).toHaveProperty("paymentPayload");
    expect(body).toHaveProperty("paymentRequirements");
  });

  it("maps each cosmos-pay invalidReason to the normalized ErrorCode", async () => {
    const cases = [
      ["invalid_signature", "invalid_signature"],
      ["invalid_authorization", "invalid_authorization"],
      ["nonce_already_used", "nonce_already_used"],
      ["expired_authorization", "expired_authorization"],
      ["insufficient_grant", "insufficient_grant"],
      ["insufficient_funds", "insufficient_funds"],
    ] as const;
    for (const [reason, expected] of cases) {
      const { fetch } = makeFetch({
        responses: [jsonResponse({ isValid: false, invalidReason: reason })],
      });
      const a = makeAdapter({ fetch });
      const r = await a.verify(verifyReq);
      expect(r.valid).toBe(false);
      expect(r.errorCode).toBe(expected);
      expect(r.errorMessage).toBe(reason);
    }
  });

  it("unknown invalidReason → provider_internal_error + logger warn", async () => {
    const warn = vi.fn();
    const { fetch } = makeFetch({
      responses: [
        jsonResponse({ isValid: false, invalidReason: "made_up_reason" }),
      ],
    });
    const a = makeAdapter({ fetch, logger: { warn } });
    const r = await a.verify(verifyReq);
    expect(r.errorCode).toBe("provider_internal_error");
    expect(r.errorMessage).toBe("made_up_reason");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("malformed JSON response shape throws ProviderError(provider_internal_error)", async () => {
    const { fetch } = makeFetch({
      responses: [jsonResponse({ totally: "wrong" })],
    });
    const a = makeAdapter({ fetch });
    await expect(a.verify(verifyReq)).rejects.toMatchObject({
      name: "ProviderError",
      code: "provider_internal_error",
      providerId: "cosmos-pay",
    });
  });
});

describe("CosmosPayAdapter /settle", () => {
  it("happy path: maps success + transaction to settled + txHash", async () => {
    const { fetch, calls } = makeFetch({
      responses: [
        jsonResponse({
          success: true,
          transaction: "ABCDEF",
          network: "cosmos:noble-1",
          payer: "noble1payer",
        }),
      ],
    });
    const a = makeAdapter({ fetch });
    const r = await a.settle(settleReq);
    expect(r.settled).toBe(true);
    expect(r.txHash).toBe("ABCDEF");
    expect(r.network).toBe("cosmos:noble-1");
    expect(r.asset).toBe("uusdc");
    expect(r.amount).toBe("10000");
    expect(r.payer).toBe("noble1payer");
    expect(calls[0]!.url).toBe("https://cosmos-pay.test/settle");
  });

  it("maps cosmos-pay's `bad_request` errorReason to invalid_request", async () => {
    const { fetch } = makeFetch({
      responses: [jsonResponse({ success: false, errorReason: "bad_request" })],
    });
    const a = makeAdapter({ fetch });
    const r = await a.settle(settleReq);
    expect(r.settled).toBe(false);
    expect(r.errorCode).toBe("invalid_request");
    expect(r.errorMessage).toBe("bad_request");
  });

  it("does NOT send Idempotency-Key by default", async () => {
    const { fetch, calls } = makeFetch({
      responses: [jsonResponse({ success: true, transaction: "T" })],
    });
    const a = makeAdapter({ fetch });
    await a.settle(settleReq);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });

  it("propagates Idempotency-Key when opts.idempotencyKey is provided", async () => {
    const { fetch, calls } = makeFetch({
      responses: [jsonResponse({ success: true, transaction: "T" })],
    });
    const a = makeAdapter({ fetch });
    await a.settle(settleReq, { idempotencyKey: "client-key-zzz" });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("client-key-zzz");
  });

  it("retries on 5xx ONLY when idempotencyKey is provided (key propagated)", async () => {
    const { fetch, calls } = makeFetch({
      responses: [
        textResponse("oops", 503),
        textResponse("oops", 503),
        jsonResponse({ success: true, transaction: "T" }),
      ],
    });
    const a = makeAdapter({ fetch });
    const result = await a.settle(settleReq, { idempotencyKey: "client-key-zzz" });
    expect(result.settled).toBe(true);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      const headers = c.init.headers as Record<string, string>;
      expect(headers["Idempotency-Key"]).toBe("client-key-zzz");
    }
  });

  it("does NOT retry on 5xx when no idempotencyKey is supplied", async () => {
    // This is the safety guarantee: without a dedupe key, a retry could
    // double-settle. Verify only one call goes out.
    const { fetch, calls } = makeFetch({
      responses: [textResponse("oops", 503)],
    });
    const a = makeAdapter({ fetch });
    await expect(a.settle(settleReq)).rejects.toMatchObject({
      code: "temporary_unavailable",
    });
    expect(calls).toHaveLength(1);
  });

  it("malformed /settle response shape throws ProviderError(provider_internal_error)", async () => {
    const { fetch } = makeFetch({
      responses: [jsonResponse({ totally: "wrong" })],
    });
    const a = makeAdapter({ fetch });
    await expect(a.settle(settleReq)).rejects.toMatchObject({
      code: "provider_internal_error",
      providerId: "cosmos-pay",
    });
  });
});

describe("CosmosPayAdapter timeout & errors", () => {
  it("translates a hung fetch into ProviderError(timeout)", async () => {
    const hung: typeof globalThis.fetch = (_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const reason = (init.signal as AbortSignal).reason;
          reject(reason instanceof Error ? reason : new Error("aborted"));
        });
      });
    const a = new CosmosPayAdapter({
      baseUrl: "https://cosmos-pay.test/",
      networkAssets: { "cosmos:noble-1": ["uusdc"] },
      estimatedFeeUsd: "0.0001",
      fetchImpl: hung,
      defaultTimeoutMs: 20,
    });
    await expect(a.verify(verifyReq)).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("CosmosPayAdapter /healthz", () => {
  it("returns healthy on 200 (empty body)", async () => {
    const { fetch } = makeFetch({ responses: [emptyResponse(200)] });
    const a = makeAdapter({ fetch });
    const h = await a.healthCheck();
    expect(h.status).toBe("healthy");
    expect(typeof h.latencyMs).toBe("number");
  });

  it("returns down on non-2xx", async () => {
    const { fetch } = makeFetch({ responses: [emptyResponse(503)] });
    const a = makeAdapter({ fetch });
    const h = await a.healthCheck();
    expect(h.status).toBe("down");
    expect(h.error).toContain("503");
  });

  it("returns down on fetch throw", async () => {
    const { fetch } = makeFetch({ responses: [new Error("ECONNREFUSED")] });
    const a = makeAdapter({ fetch });
    const h = await a.healthCheck();
    expect(h.status).toBe("down");
    expect(h.error).toBeDefined();
  });
});

describe("CosmosPayAdapter /supported (discoverCapabilities)", () => {
  it("cross-joins discovered networks with configured assets", async () => {
    const { fetch } = makeFetch({
      responses: [
        jsonResponse({
          kinds: [
            { scheme: "exact_cosmos_authz", network: "cosmos:noble-1" },
            { scheme: "exact_cosmos_authz", network: "cosmos:grand-1" },
          ],
        }),
      ],
    });
    const a = makeAdapter({ fetch });
    const caps = await a.discoverCapabilities();
    expect(caps).toEqual([
      { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      { network: "cosmos:grand-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
    ]);
  });

  it("skips discovered networks not in networkAssets with a warning", async () => {
    const warn = vi.fn();
    const { fetch } = makeFetch({
      responses: [
        jsonResponse({
          kinds: [
            { scheme: "exact_cosmos_authz", network: "cosmos:noble-1" },
            { scheme: "exact_cosmos_authz", network: "cosmos:unknown-99" },
          ],
        }),
      ],
    });
    const a = makeAdapter({ fetch, logger: { warn } });
    const caps = await a.discoverCapabilities();
    expect(caps).toHaveLength(1);
    expect(caps[0]!.network).toBe("cosmos:noble-1");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("cosmos:unknown-99"),
      expect.objectContaining({ network: "cosmos:unknown-99" }),
    );
  });

  it("emits per-kind extras when granteeAddress is configured (PR-A)", async () => {
    const { fetch } = makeFetch({
      responses: [
        jsonResponse({
          kinds: [
            { scheme: "exact_cosmos_authz", network: "cosmos:noble-1" },
          ],
        }),
      ],
    });
    const adapter = new CosmosPayAdapter({
      baseUrl: "https://cosmos-pay.test/",
      networkAssets: { "cosmos:noble-1": ["uusdc"] },
      estimatedFeeUsd: "0.0001",
      granteeAddress: "noble18jq3tgk39z8qk5jz304zqkhd02gs5zkhrj7sqt",
      fetchImpl: fetch,
    });
    const caps = await adapter.discoverCapabilities();
    expect(caps).toEqual([
      {
        network: "cosmos:noble-1",
        asset: "uusdc",
        scheme: "exact_cosmos_authz",
        extra: {
          facilitator: "noble18jq3tgk39z8qk5jz304zqkhd02gs5zkhrj7sqt",
          chainId: "noble-1",
          decimals: 6,
          symbol: "USDC",
        },
      },
    ]);
  });

  it("omits per-kind extras when granteeAddress is NOT configured (backward compat)", async () => {
    const { fetch } = makeFetch({
      responses: [
        jsonResponse({
          kinds: [
            { scheme: "exact_cosmos_authz", network: "cosmos:noble-1" },
          ],
        }),
      ],
    });
    // Stock makeAdapter() — no granteeAddress.
    const a = makeAdapter({ fetch });
    const caps = await a.discoverCapabilities();
    expect(caps).toHaveLength(1);
    expect(caps[0]!.extra).toBeUndefined();
  });

  it("throws on malformed /supported body", async () => {
    const { fetch } = makeFetch({
      responses: [jsonResponse({ wrong: "shape" })],
    });
    const a = makeAdapter({ fetch });
    await expect(a.discoverCapabilities()).rejects.toMatchObject({
      code: "provider_internal_error",
      providerId: "cosmos-pay",
    });
  });
});

describe("CosmosPayAdapter getStatus (hint-based)", () => {
  it("settled when hints carry a txHash", async () => {
    const { fetch } = makeFetch({ responses: [] });
    const a = makeAdapter({ fetch });
    const s = await a.getStatus("pay_x", { txHash: "ABC123" });
    expect(s.status).toBe("settled");
    expect(s.txHash).toBe("ABC123");
  });

  it("failed when hints carry an errorCode (no txHash)", async () => {
    const { fetch } = makeFetch({ responses: [] });
    const a = makeAdapter({ fetch });
    const s = await a.getStatus("pay_x", { errorCode: "broadcast_failed" });
    expect(s.status).toBe("failed");
    expect(s.errorCode).toBe("broadcast_failed");
  });

  it("pending when no hints are provided", async () => {
    const { fetch } = makeFetch({ responses: [] });
    const a = makeAdapter({ fetch });
    const s = await a.getStatus("pay_x");
    expect(s.status).toBe("pending");
  });
});
