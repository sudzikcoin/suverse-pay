import type { SettleRequest, VerifyRequest } from "@suverse-pay/core-types";
import { describe, expect, it, vi } from "vitest";
import {
  PayAiAdapter,
  type PayAiCapabilityConfig,
  type PayAiLogger,
} from "./adapter.js";

interface FetchCall {
  url: string;
  init: RequestInit;
  body: unknown;
}

function makeFetch(
  responses: ReadonlyArray<Response | Error>,
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const rawBody = init?.body;
    const body =
      typeof rawBody === "string" ? (JSON.parse(rawBody) as unknown) : undefined;
    calls.push({ url, init: init ?? {}, body });
    if (i >= responses.length) {
      throw new Error(`fetch called more times than scripted (i=${i})`);
    }
    const next = responses[i++]!;
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

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAYAI_FEE_PAYER = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const PAYER = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";

const BASE_CAPS: PayAiCapabilityConfig[] = [
  { network: SOLANA_MAINNET, asset: SOLANA_USDC_MINT, scheme: "exact" },
];

interface AdapterOverrides {
  fetch: typeof globalThis.fetch;
  apiKeyId?: string;
  apiKeySecret?: string;
  logger?: PayAiLogger;
  baseUrl?: string;
}

function makeAdapter(o: AdapterOverrides): PayAiAdapter {
  return new PayAiAdapter({
    capabilities: BASE_CAPS,
    estimatedFeeUsd: "0.001",
    fetchImpl: o.fetch,
    ...(o.apiKeyId !== undefined ? { apiKeyId: o.apiKeyId } : {}),
    ...(o.apiKeySecret !== undefined ? { apiKeySecret: o.apiKeySecret } : {}),
    ...(o.logger !== undefined ? { logger: o.logger } : {}),
    ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
  });
}

const svmVerifyReq: VerifyRequest = {
  paymentPayload: {
    x402Version: 2,
    scheme: "exact",
    network: SOLANA_MAINNET,
    payload: { transaction: "AAAA" },
  },
  paymentRequirements: {
    scheme: "exact",
    network: SOLANA_MAINNET,
    maxAmountRequired: "1000",
    asset: SOLANA_USDC_MINT,
    payTo: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4",
    resource: "https://api.example.test/svm",
    maxTimeoutSeconds: 60,
    extra: { feePayer: PAYAI_FEE_PAYER, decimals: 6, symbol: "USDC" },
  },
};

const svmSettleReq: SettleRequest = svmVerifyReq;

describe("PayAiAdapter basics", () => {
  it("exposes id + default displayName + default baseUrl", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ kinds: [{ x402Version: 2, scheme: "exact", network: SOLANA_MAINNET }] }),
    ]);
    const a = makeAdapter({ fetch });
    expect(a.id).toBe("payai");
    expect(a.displayName).toBe("PayAI Facilitator");
    // The default base URL hits the canonical hosted facilitator.
    await a.discoverCapabilities();
    expect(calls[0]!.url).toBe("https://facilitator.payai.network/supported");
  });

  it("supports(): true for configured Solana USDC capability", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    expect(
      await a.supports({
        network: SOLANA_MAINNET,
        asset: SOLANA_USDC_MINT,
        scheme: "exact",
      }),
    ).toEqual({ supported: true });
  });

  it("supports(): rejects the legacy `solana:mainnet` form so we don't double-register", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    expect(
      (
        await a.supports({
          network: "solana:mainnet",
          asset: SOLANA_USDC_MINT,
          scheme: "exact",
        })
      ).supported,
    ).toBe(false);
  });

  it("supports(): rejects the legacy `solana` short name (v1 facilitator path)", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    expect(
      (await a.supports({ network: "solana", asset: SOLANA_USDC_MINT, scheme: "exact" })).supported,
    ).toBe(false);
  });

  it("quote(): synthetic, returns configured fee", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    const q = await a.quote({
      network: SOLANA_MAINNET,
      asset: SOLANA_USDC_MINT,
      amount: "1000",
      scheme: "exact",
    });
    expect(q.source).toBe("synthetic");
    expect(q.estimatedFeeUsd).toBe("0.001");
    expect(q.providerId).toBe("payai");
  });
});

describe("PayAiAdapter auth header", () => {
  it("sends NO Authorization header on the free tier (no apiKeyId/secret)", async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ isValid: true })]);
    const a = makeAdapter({ fetch });
    await a.verify(svmVerifyReq);
    const headers = calls[0]!.init.headers as Record<string, string> | undefined;
    expect(headers).toBeDefined();
    // The adapter only injects content-type + idempotency-key; auth is absent.
    expect(headers!["Authorization"]).toBeUndefined();
    expect(headers!["authorization"]).toBeUndefined();
  });

  it("sends Basic auth when apiKeyId + apiKeySecret are provided (paid tier)", async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ isValid: true })]);
    const a = makeAdapter({ fetch, apiKeyId: "key-id-123", apiKeySecret: "secret-abc" });
    await a.verify(svmVerifyReq);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toMatch(/^Basic /);
    // Decode and confirm format.
    const encoded = headers["Authorization"]!.replace(/^Basic /, "");
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    expect(decoded).toBe("key-id-123:secret-abc");
  });

  it("does NOT send auth when only one of (apiKeyId, apiKeySecret) is set", async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ isValid: true })]);
    const a = makeAdapter({ fetch, apiKeyId: "key-id-only" });
    await a.verify(svmVerifyReq);
    const headers = calls[0]!.init.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBeUndefined();
  });
});

describe("PayAiAdapter /verify", () => {
  it("happy path: parses isValid + payer", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ isValid: true, payer: PAYER }),
    ]);
    const a = makeAdapter({ fetch });
    const r = await a.verify(svmVerifyReq);
    expect(r.valid).toBe(true);
    expect(r.payer).toBe(PAYER);
    expect(calls[0]!.url).toBe("https://facilitator.payai.network/verify");
  });

  it("forwards the SVM payload shape (base64 transaction) verbatim", async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ isValid: true })]);
    const a = makeAdapter({ fetch });
    await a.verify(svmVerifyReq);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.x402Version).toBe(2);
    const pp = body.paymentPayload as Record<string, unknown>;
    expect(pp.network).toBe(SOLANA_MAINNET);
    expect((pp.payload as Record<string, unknown>).transaction).toBe("AAAA");
    const pr = body.paymentRequirements as Record<string, unknown>;
    expect((pr.extra as Record<string, unknown>).feePayer).toBe(PAYAI_FEE_PAYER);
  });

  it("uses invalidMessage as errorMessage when present", async () => {
    const { fetch } = makeFetch([
      jsonResponse({
        isValid: false,
        invalidReason: "invalid_signature",
        invalidMessage: "ed25519 verification failed",
      }),
    ]);
    const a = makeAdapter({ fetch });
    const r = await a.verify(svmVerifyReq);
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("invalid_signature");
    expect(r.errorMessage).toBe("ed25519 verification failed");
  });

  it("falls back to invalidReason as errorMessage when invalidMessage is absent", async () => {
    const { fetch } = makeFetch([
      jsonResponse({ isValid: false, invalidReason: "duplicate_settlement" }),
    ]);
    const a = makeAdapter({ fetch });
    const r = await a.verify(svmVerifyReq);
    expect(r.errorCode).toBe("duplicate_idempotency_key");
    expect(r.errorMessage).toBe("duplicate_settlement");
  });

  it("unknown invalidReason → provider_internal_error + warn", async () => {
    const warn = vi.fn();
    const { fetch } = makeFetch([
      jsonResponse({
        isValid: false,
        invalidReason: "brand_new_payai_code",
        invalidMessage: "details",
      }),
    ]);
    const a = makeAdapter({ fetch, logger: { warn } });
    const r = await a.verify(svmVerifyReq);
    expect(r.errorCode).toBe("provider_internal_error");
    expect(r.errorMessage).toBe("details");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("malformed /verify body throws ProviderError(provider_internal_error)", async () => {
    const { fetch } = makeFetch([jsonResponse({ wrong: "shape" })]);
    const a = makeAdapter({ fetch });
    await expect(a.verify(svmVerifyReq)).rejects.toMatchObject({
      name: "ProviderError",
      code: "provider_internal_error",
      providerId: "payai",
    });
  });

  it("translates an HTTP 401 to ProviderError(unauthorized)", async () => {
    const { fetch } = makeFetch([textResponse("unauthorized", 401)]);
    const a = makeAdapter({ fetch });
    await expect(a.verify(svmVerifyReq)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
});

describe("PayAiAdapter /settle", () => {
  it("happy path: returns the base58 Solana signature unchanged", async () => {
    const svmTxSig =
      "5KQwrPbwdL6PhXujxW37FSSbT5HG4d6V8c5jYrqWwG6QrBmbX2RhPZ8M9LrgDmBnYpZHVz9KvxWsyABcdEfGhij1";
    const { fetch } = makeFetch([
      jsonResponse({
        success: true,
        transaction: svmTxSig,
        network: SOLANA_MAINNET,
        amount: "1000",
        payer: PAYER,
      }),
    ]);
    const a = makeAdapter({ fetch });
    const r = await a.settle(svmSettleReq);
    expect(r.settled).toBe(true);
    expect(r.txHash).toBe(svmTxSig);
    expect(r.network).toBe(SOLANA_MAINNET);
    expect(r.amount).toBe("1000");
    expect(r.payer).toBe(PAYER);
  });

  it("propagates Solana broadcast_failed with errorMessage", async () => {
    const { fetch } = makeFetch([
      jsonResponse({
        success: false,
        errorReason: "broadcast_failed",
        errorMessage: "blockhash expired",
        network: SOLANA_MAINNET,
      }),
    ]);
    const a = makeAdapter({ fetch });
    const r = await a.settle(svmSettleReq);
    expect(r.settled).toBe(false);
    expect(r.errorCode).toBe("broadcast_failed");
    expect(r.errorMessage).toBe("blockhash expired");
  });

  it("falls back to requirements.maxAmountRequired when response omits amount", async () => {
    const { fetch } = makeFetch([
      jsonResponse({ success: true, transaction: "txsig" }),
    ]);
    const a = makeAdapter({ fetch });
    const r = await a.settle(svmSettleReq);
    expect(r.amount).toBe("1000");
  });

  it("does NOT send Idempotency-Key by default", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ success: true, transaction: "txsig" }),
    ]);
    const a = makeAdapter({ fetch });
    await a.settle(svmSettleReq);
    const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });

  it("propagates Idempotency-Key + retries on 5xx when key is provided", async () => {
    // First call: 503 → retry. Second call: 200.
    const { fetch, calls } = makeFetch([
      textResponse("upstream gone", 503),
      jsonResponse({ success: true, transaction: "txsig" }),
    ]);
    const a = makeAdapter({ fetch });
    const r = await a.settle(svmSettleReq, { idempotencyKey: "idem-123" });
    expect(r.settled).toBe(true);
    expect(calls.length).toBe(2);
    const headers0 = calls[0]!.init.headers as Record<string, string>;
    const headers1 = calls[1]!.init.headers as Record<string, string>;
    expect(headers0["Idempotency-Key"]).toBe("idem-123");
    expect(headers1["Idempotency-Key"]).toBe("idem-123");
  });
});

describe("PayAiAdapter healthCheck", () => {
  it("returns healthy on 200 from /supported", async () => {
    const { fetch } = makeFetch([
      jsonResponse({ kinds: [{ x402Version: 2, scheme: "exact", network: SOLANA_MAINNET }] }),
    ]);
    const a = makeAdapter({ fetch });
    const h = await a.healthCheck();
    expect(h.status).toBe("healthy");
  });

  it("returns down on 5xx", async () => {
    const { fetch } = makeFetch([textResponse("upstream gone", 502)]);
    const a = makeAdapter({ fetch });
    const h = await a.healthCheck();
    expect(h.status).toBe("down");
    expect(h.error).toContain("502");
  });

  it("returns down on network failure", async () => {
    const { fetch } = makeFetch([new Error("ECONNREFUSED")]);
    const a = makeAdapter({ fetch });
    const h = await a.healthCheck();
    expect(h.status).toBe("down");
  });
});

describe("PayAiAdapter discoverCapabilities", () => {
  it("filters out v1 entries — only x402 v2 (CAIP-2 networks) are kept", async () => {
    const { fetch } = makeFetch([
      jsonResponse({
        kinds: [
          // Legacy v1 entries advertised by PayAI for backwards compatibility.
          { x402Version: 1, scheme: "exact", network: "solana", extra: { feePayer: PAYAI_FEE_PAYER } },
          { x402Version: 1, scheme: "exact", network: "solana-devnet", extra: { feePayer: PAYAI_FEE_PAYER } },
          // v2 entry — the one we actually use.
          { x402Version: 2, scheme: "exact", network: SOLANA_MAINNET, extra: { feePayer: PAYAI_FEE_PAYER } },
        ],
      }),
    ]);
    const a = makeAdapter({ fetch });
    const caps = await a.discoverCapabilities();
    expect(caps).toEqual([
      {
        network: SOLANA_MAINNET,
        asset: SOLANA_USDC_MINT,
        scheme: "exact",
        // PR-A: per-kind extras now flow through from upstream — Solana
        // entries carry `feePayer` which the buyer SDK needs to build the
        // partial-signed VersionedTransaction.
        extra: { feePayer: PAYAI_FEE_PAYER },
      },
    ]);
  });

  it("skips v2 entries not present in the static config + warns", async () => {
    const warn = vi.fn();
    const { fetch } = makeFetch([
      jsonResponse({
        kinds: [
          { x402Version: 2, scheme: "exact", network: SOLANA_MAINNET },
          // Not in static config — should be skipped.
          { x402Version: 2, scheme: "exact", network: "eip155:43114" },
        ],
      }),
    ]);
    const a = makeAdapter({ fetch, logger: { warn } });
    const caps = await a.discoverCapabilities();
    expect(caps.map((c) => c.network)).toEqual([SOLANA_MAINNET]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("throws on malformed /supported body", async () => {
    const { fetch } = makeFetch([jsonResponse({ kinds: "not-an-array" })]);
    const a = makeAdapter({ fetch });
    await expect(a.discoverCapabilities()).rejects.toMatchObject({
      code: "provider_internal_error",
      providerId: "payai",
    });
  });
});

describe("PayAiAdapter getStatus", () => {
  it("settled when hints carry a txHash", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    expect((await a.getStatus("pay_x", { txHash: "abc" })).status).toBe("settled");
  });

  it("failed when hints carry an errorCode", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    const s = await a.getStatus("pay_x", { errorCode: "broadcast_failed" });
    expect(s.status).toBe("failed");
    expect(s.errorCode).toBe("broadcast_failed");
  });

  it("pending when no hints", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    expect((await a.getStatus("pay_x")).status).toBe("pending");
  });
});

describe("PayAiAdapter URL parsing", () => {
  it("strips a trailing slash from the configured baseUrl", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ kinds: [{ x402Version: 2, scheme: "exact", network: SOLANA_MAINNET }] }),
    ]);
    const a = makeAdapter({
      fetch,
      baseUrl: "https://facilitator.payai.network/",
    });
    await a.discoverCapabilities();
    expect(calls[0]!.url).toBe("https://facilitator.payai.network/supported");
  });
});
