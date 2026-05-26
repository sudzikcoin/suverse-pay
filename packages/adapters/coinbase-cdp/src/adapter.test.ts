import type { SettleRequest, VerifyRequest } from "@suverse-pay/core-types";
import { ProviderError } from "@suverse-pay/core-types";
import { describe, expect, it, vi } from "vitest";
import { CoinbaseCdpAdapter, type CdpCapabilityConfig } from "./adapter.js";
import type { CdpLogger } from "./error-map.js";
import type { CdpJwtSigner } from "./jwt-signer.js";
import { InMemoryUsageTracker } from "./usage-tracker.js";

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

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

const FAKE_SIGNER: CdpJwtSigner = {
  async sign() {
    return "FAKE.JWT.TOKEN";
  },
};

const BASE_CAPS: CdpCapabilityConfig[] = [
  { network: "eip155:8453", asset: "0xUSDC", scheme: "exact" },
  { network: "eip155:137", asset: "0xUSDC_POLY", scheme: "exact" },
  { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFW", scheme: "exact" },
];

interface AdapterOverrides {
  fetch: typeof globalThis.fetch;
  monthlyHardCap?: number;
  usageTracker?: InMemoryUsageTracker;
  logger?: CdpLogger;
  baseUrl?: string;
}

function makeAdapter(o: AdapterOverrides): CoinbaseCdpAdapter {
  return new CoinbaseCdpAdapter({
    apiKeyName: "organizations/test/apiKeys/test",
    apiKeySecret: "ignored-because-signer-is-stubbed",
    capabilities: BASE_CAPS,
    estimatedFeeUsd: "0.001",
    signer: FAKE_SIGNER,
    fetchImpl: o.fetch,
    ...(o.monthlyHardCap !== undefined ? { monthlyHardCap: o.monthlyHardCap } : {}),
    ...(o.usageTracker !== undefined ? { usageTracker: o.usageTracker } : {}),
    ...(o.logger !== undefined ? { logger: o.logger } : {}),
    ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
  });
}

const verifyReq: VerifyRequest = {
  paymentPayload: {
    x402Version: 2,
    scheme: "exact",
    network: "eip155:8453",
    payload: {
      signature: "0xsig",
      authorization: {
        from: "0xpayer",
        to: "0xrecipient",
        value: "10000",
        validAfter: "1740672089",
        validBefore: "1740672154",
        nonce: "0xnonce",
      },
    },
  },
  paymentRequirements: {
    scheme: "exact",
    network: "eip155:8453",
    maxAmountRequired: "10000",
    asset: "0xUSDC",
    payTo: "0xrecipient",
    resource: "https://api.example.test/x",
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  },
};

const settleReq: SettleRequest = verifyReq;

describe("CoinbaseCdpAdapter basics", () => {
  it("exposes id + displayName", () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    expect(a.id).toBe("coinbase-cdp");
    expect(a.displayName).toBe("Coinbase CDP");
  });

  it("supports(): true for exact configured (network, asset, scheme)", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    expect(
      await a.supports({ network: "eip155:8453", asset: "0xUSDC", scheme: "exact" }),
    ).toEqual({ supported: true });
  });

  it("supports(): false on any mismatch", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    expect(
      (
        await a.supports({
          network: "eip155:8453",
          asset: "0xUSDC",
          scheme: "exact_cosmos_authz",
        })
      ).supported,
    ).toBe(false);
    expect(
      (
        await a.supports({
          network: "eip155:8453",
          asset: "0xWRONG",
          scheme: "exact",
        })
      ).supported,
    ).toBe(false);
    expect(
      (
        await a.supports({
          network: "eip155:999",
          asset: "0xUSDC",
          scheme: "exact",
        })
      ).supported,
    ).toBe(false);
  });

  it("supports(): returns quota_exceeded when usage >= hard cap", async () => {
    const { fetch } = makeFetch([]);
    const tracker = new InMemoryUsageTracker(5);
    const a = makeAdapter({ fetch, monthlyHardCap: 5, usageTracker: tracker });
    const result = await a.supports({
      network: "eip155:8453",
      asset: "0xUSDC",
      scheme: "exact",
    });
    expect(result).toEqual({ supported: false, reason: "quota_exceeded" });
  });

  it("supports(): still rejects mismatched route even when under cap", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch, monthlyHardCap: 10000 });
    expect(
      (
        await a.supports({
          network: "eip155:99999",
          asset: "0xX",
          scheme: "exact",
        })
      ).supported,
    ).toBe(false);
  });

  it("quote(): synthetic, returns configured fee", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    const q = await a.quote({
      network: "eip155:8453",
      asset: "0xUSDC",
      amount: "10000",
      scheme: "exact",
    });
    expect(q.source).toBe("synthetic");
    expect(q.estimatedFeeUsd).toBe("0.001");
    expect(q.providerId).toBe("coinbase-cdp");
  });
});

describe("CoinbaseCdpAdapter /verify", () => {
  it("sends a Bearer JWT and parses isValid + payer", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ isValid: true, payer: "0xpayer" }),
    ]);
    const a = makeAdapter({ fetch });
    const result = await a.verify(verifyReq);
    expect(result.valid).toBe(true);
    expect(result.payer).toBe("0xpayer");
    expect(calls[0]!.url).toBe(
      "https://api.cdp.coinbase.com/platform/v2/x402/verify",
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer FAKE.JWT.TOKEN");
  });

  it("forwards a properly-shaped x402 v2 VerifyRequest body", async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ isValid: true })]);
    const a = makeAdapter({ fetch });
    await a.verify(verifyReq);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body).toHaveProperty("x402Version", 2);
    expect(body).toHaveProperty("paymentPayload");
    expect(body).toHaveProperty("paymentRequirements");
  });

  it("uses invalidMessage as errorMessage when both reason and message are present", async () => {
    const { fetch } = makeFetch([
      jsonResponse({
        isValid: false,
        invalidReason: "invalid_signature",
        invalidMessage: "ECDSA recovery failed",
      }),
    ]);
    const a = makeAdapter({ fetch });
    const r = await a.verify(verifyReq);
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("invalid_signature");
    expect(r.errorMessage).toBe("ECDSA recovery failed");
  });

  it("falls back to invalidReason as errorMessage when no invalidMessage", async () => {
    const { fetch } = makeFetch([
      jsonResponse({ isValid: false, invalidReason: "nonce_already_used" }),
    ]);
    const a = makeAdapter({ fetch });
    const r = await a.verify(verifyReq);
    expect(r.errorCode).toBe("nonce_already_used");
    expect(r.errorMessage).toBe("nonce_already_used");
  });

  it("unknown invalidReason → provider_internal_error + warn", async () => {
    const warn = vi.fn();
    const { fetch } = makeFetch([
      jsonResponse({ isValid: false, invalidReason: "new_cdp_code", invalidMessage: "details" }),
    ]);
    const a = makeAdapter({ fetch, logger: { warn } });
    const r = await a.verify(verifyReq);
    expect(r.errorCode).toBe("provider_internal_error");
    expect(r.errorMessage).toBe("details");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("malformed /verify body throws ProviderError(provider_internal_error)", async () => {
    const { fetch } = makeFetch([jsonResponse({ wrong: "shape" })]);
    const a = makeAdapter({ fetch });
    await expect(a.verify(verifyReq)).rejects.toMatchObject({
      name: "ProviderError",
      code: "provider_internal_error",
      providerId: "coinbase-cdp",
    });
  });

  it("translates an HTTP 401 to ProviderError(unauthorized)", async () => {
    const { fetch } = makeFetch([textResponse("nope", 401)]);
    const a = makeAdapter({ fetch });
    await expect(a.verify(verifyReq)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
});

describe("CoinbaseCdpAdapter /settle", () => {
  it("happy path: maps success + transaction + extra amount to settled / txHash / amount", async () => {
    const tracker = new InMemoryUsageTracker();
    const { fetch, calls } = makeFetch([
      jsonResponse({
        success: true,
        transaction: "0xabc",
        network: "eip155:8453",
        amount: "10000",
        payer: "0xpayer",
      }),
    ]);
    const a = makeAdapter({ fetch, usageTracker: tracker });
    const r = await a.settle(settleReq);
    expect(r.settled).toBe(true);
    expect(r.txHash).toBe("0xabc");
    expect(r.amount).toBe("10000");
    expect(r.payer).toBe("0xpayer");
    expect(calls[0]!.url).toBe(
      "https://api.cdp.coinbase.com/platform/v2/x402/settle",
    );
    expect(await tracker.current()).toBe(1);
  });

  it("falls back to requirements.maxAmountRequired when response omits amount", async () => {
    const { fetch } = makeFetch([
      jsonResponse({ success: true, transaction: "0xabc" }),
    ]);
    const a = makeAdapter({ fetch });
    const r = await a.settle(settleReq);
    expect(r.amount).toBe("10000");
  });

  it("usage counter does NOT increment on settle failure", async () => {
    const tracker = new InMemoryUsageTracker();
    const { fetch } = makeFetch([
      jsonResponse({ success: false, errorReason: "broadcast_failed" }),
    ]);
    const a = makeAdapter({ fetch, usageTracker: tracker });
    const r = await a.settle(settleReq);
    expect(r.settled).toBe(false);
    expect(r.errorCode).toBe("broadcast_failed");
    expect(await tracker.current()).toBe(0);
  });

  it("normalizes EVM-specific errorReasons (insufficient_allowance → insufficient_grant)", async () => {
    const { fetch } = makeFetch([
      jsonResponse({ success: false, errorReason: "insufficient_allowance" }),
    ]);
    const a = makeAdapter({ fetch });
    const r = await a.settle(settleReq);
    expect(r.errorCode).toBe("insufficient_grant");
  });

  it("does NOT send Idempotency-Key by default", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ success: true, transaction: "0xabc" }),
    ]);
    const a = makeAdapter({ fetch });
    await a.settle(settleReq);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });

  it("propagates Idempotency-Key when supplied", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ success: true, transaction: "0xabc" }),
    ]);
    const a = makeAdapter({ fetch });
    await a.settle(settleReq, { idempotencyKey: "cdp-key-yy" });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("cdp-key-yy");
  });

  it("retries on 5xx ONLY when idempotencyKey is provided (key on every attempt)", async () => {
    const { fetch, calls } = makeFetch([
      textResponse("upstream blip", 503),
      textResponse("upstream blip", 503),
      jsonResponse({ success: true, transaction: "0xabc" }),
    ]);
    const a = makeAdapter({ fetch });
    const r = await a.settle(settleReq, { idempotencyKey: "cdp-key-zz" });
    expect(r.settled).toBe(true);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      const headers = c.init.headers as Record<string, string>;
      expect(headers["Idempotency-Key"]).toBe("cdp-key-zz");
    }
  });

  it("does NOT retry on 5xx without idempotencyKey", async () => {
    const { fetch, calls } = makeFetch([textResponse("blip", 503)]);
    const a = makeAdapter({ fetch });
    await expect(a.settle(settleReq)).rejects.toMatchObject({
      code: "temporary_unavailable",
    });
    expect(calls).toHaveLength(1);
  });

  it("malformed /settle body throws ProviderError(provider_internal_error)", async () => {
    const { fetch } = makeFetch([jsonResponse({ wrong: "shape" })]);
    const a = makeAdapter({ fetch });
    await expect(a.settle(settleReq)).rejects.toMatchObject({
      code: "provider_internal_error",
      providerId: "coinbase-cdp",
    });
  });
});

describe("CoinbaseCdpAdapter timeout", () => {
  it("translates a hung fetch into ProviderError(timeout)", async () => {
    const hung: typeof globalThis.fetch = (_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const reason = (init.signal as AbortSignal).reason;
          reject(reason instanceof Error ? reason : new Error("aborted"));
        });
      });
    const a = new CoinbaseCdpAdapter({
      apiKeyName: "n",
      apiKeySecret: "ignored",
      capabilities: BASE_CAPS,
      estimatedFeeUsd: "0.001",
      signer: FAKE_SIGNER,
      fetchImpl: hung,
      defaultTimeoutMs: 20,
    });
    await expect(a.verify(verifyReq)).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("CoinbaseCdpAdapter healthCheck", () => {
  it("returns healthy on 200 from /supported", async () => {
    const { fetch } = makeFetch([
      jsonResponse({ kinds: [{ scheme: "exact", network: "eip155:8453" }] }),
    ]);
    const a = makeAdapter({ fetch });
    const h = await a.healthCheck();
    expect(h.status).toBe("healthy");
  });

  it("returns down on 401 / 403 / 5xx", async () => {
    const { fetch } = makeFetch([emptyResponse(401)]);
    const a = makeAdapter({ fetch });
    const h = await a.healthCheck();
    expect(h.status).toBe("down");
    expect(h.error).toContain("401");
  });

  it("returns down on network failure", async () => {
    const { fetch } = makeFetch([new Error("ECONNREFUSED")]);
    const a = makeAdapter({ fetch });
    const h = await a.healthCheck();
    expect(h.status).toBe("down");
  });
});

describe("CoinbaseCdpAdapter discoverCapabilities", () => {
  it("cross-joins discovered (scheme, network) pairs with configured assets", async () => {
    const { fetch } = makeFetch([
      jsonResponse({
        kinds: [
          { scheme: "exact", network: "eip155:8453" },
          { scheme: "exact", network: "eip155:137" },
        ],
      }),
    ]);
    const a = makeAdapter({ fetch });
    const caps = await a.discoverCapabilities();
    expect(caps).toEqual([
      { network: "eip155:8453", asset: "0xUSDC", scheme: "exact" },
      { network: "eip155:137", asset: "0xUSDC_POLY", scheme: "exact" },
    ]);
  });

  it("skips discovered (scheme, network) pairs without a matching configured asset", async () => {
    const warn = vi.fn();
    const { fetch } = makeFetch([
      jsonResponse({
        kinds: [
          { scheme: "exact", network: "eip155:8453" },
          { scheme: "exact", network: "eip155:42161" }, // configured network: NO
          { scheme: "upto", network: "eip155:8453" }, // configured scheme: NO
        ],
      }),
    ]);
    const a = makeAdapter({ fetch, logger: { warn } });
    const caps = await a.discoverCapabilities();
    expect(caps).toEqual([
      { network: "eip155:8453", asset: "0xUSDC", scheme: "exact" },
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("throws on malformed /supported body", async () => {
    const { fetch } = makeFetch([jsonResponse({ kinds: "not-an-array" })]);
    const a = makeAdapter({ fetch });
    await expect(a.discoverCapabilities()).rejects.toMatchObject({
      code: "provider_internal_error",
      providerId: "coinbase-cdp",
    });
  });
});

describe("CoinbaseCdpAdapter getStatus", () => {
  it("settled when hints carry a txHash", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    expect((await a.getStatus("pay_x", { txHash: "0xabc" })).status).toBe(
      "settled",
    );
  });

  it("failed when hints carry an errorCode (no txHash)", async () => {
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

describe("CoinbaseCdpAdapter URL parsing", () => {
  it("strips a trailing slash from the configured baseUrl", () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({
      fetch,
      baseUrl: "https://api.cdp.coinbase.com/platform/v2/x402/",
    });
    expect(a.id).toBe("coinbase-cdp");
  });

  it("uses the JWT signer's uri field per call (verify hits /verify)", async () => {
    const sign = vi.fn(async () => "JWT.STUB");
    const { fetch } = makeFetch([jsonResponse({ isValid: true })]);
    const a = new CoinbaseCdpAdapter({
      apiKeyName: "n",
      apiKeySecret: "ignored",
      capabilities: BASE_CAPS,
      estimatedFeeUsd: "0.001",
      signer: { sign },
      fetchImpl: fetch,
    });
    await a.verify(verifyReq);
    expect(sign).toHaveBeenCalledWith({
      method: "POST",
      host: "api.cdp.coinbase.com",
      path: "/platform/v2/x402/verify",
    });
  });
});
