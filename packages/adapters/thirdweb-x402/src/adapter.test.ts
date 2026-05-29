import type { SettleRequest, VerifyRequest } from "@suverse-pay/core-types";
import { describe, expect, it, vi } from "vitest";
import {
  ThirdwebX402Adapter,
  type ThirdwebCapabilityConfig,
  type ThirdwebLogger,
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

const OPTIMISM = "eip155:10";
const OPTIMISM_USDC = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const ETH_MAINNET = "eip155:1";
const ETH_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const PAYER = "0xA2F8a871AfDC463aaEf5FAe8284d900f4d02538E";

const BASE_CAPS: ThirdwebCapabilityConfig[] = [
  { network: OPTIMISM, asset: OPTIMISM_USDC, scheme: "exact" },
  { network: ETH_MAINNET, asset: ETH_USDC, scheme: "exact" },
];

interface AdapterOverrides {
  fetch: typeof globalThis.fetch;
  apiKey?: string;
  authHeaderName?: string;
  baseUrl?: string;
  logger?: ThirdwebLogger;
  waitUntil?: "simulated" | "submitted" | "confirmed";
}

function makeAdapter(o: AdapterOverrides): ThirdwebX402Adapter {
  return new ThirdwebX402Adapter({
    capabilities: BASE_CAPS,
    estimatedFeeUsd: "0.001",
    fetchImpl: o.fetch,
    ...(o.apiKey !== undefined ? { apiKey: o.apiKey } : {}),
    ...(o.authHeaderName !== undefined ? { authHeaderName: o.authHeaderName } : {}),
    ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
    ...(o.logger !== undefined ? { logger: o.logger } : {}),
    ...(o.waitUntil !== undefined ? { waitUntil: o.waitUntil } : {}),
  });
}

const evmVerifyReq: VerifyRequest = {
  paymentPayload: {
    x402Version: 1,
    scheme: "exact",
    network: OPTIMISM,
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: {
        from: PAYER,
        to: "0x000000000000000000000000000000000000bEEF",
        value: "1000",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: "0x" + "11".repeat(32),
      },
    },
  },
  paymentRequirements: {
    scheme: "exact",
    network: OPTIMISM,
    maxAmountRequired: "1000",
    asset: OPTIMISM_USDC,
    payTo: "0x000000000000000000000000000000000000bEEF",
    resource: "https://api.example.test/optimism",
    maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
  },
};

const evmSettleReq: SettleRequest = evmVerifyReq;

describe("ThirdwebX402Adapter basics", () => {
  it("exposes id + default displayName + default baseUrl (Nexus)", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({
        kinds: [{ x402Version: 1, scheme: "exact", network: OPTIMISM }],
      }),
    ]);
    const a = makeAdapter({ fetch });
    expect(a.id).toBe("thirdweb-x402");
    expect(a.displayName).toBe("Thirdweb Nexus x402 Facilitator");
    await a.discoverCapabilities();
    expect(calls[0]!.url).toBe("https://nexus-api.thirdweb.com/supported");
  });

  it("supports(): true for configured Optimism USDC capability", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    expect(
      await a.supports({ network: OPTIMISM, asset: OPTIMISM_USDC, scheme: "exact" }),
    ).toEqual({ supported: true });
  });

  it("supports(): false for an unconfigured network (Avalanche — covered by PayAI)", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    expect(
      (
        await a.supports({
          network: "eip155:43114",
          asset: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
          scheme: "exact",
        })
      ).supported,
    ).toBe(false);
  });

  it("quote(): synthetic, returns configured fee", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    const q = await a.quote({
      network: OPTIMISM,
      asset: OPTIMISM_USDC,
      amount: "1000",
      scheme: "exact",
    });
    expect(q.source).toBe("synthetic");
    expect(q.estimatedFeeUsd).toBe("0.001");
    expect(q.providerId).toBe("thirdweb-x402");
  });
});

describe("ThirdwebX402Adapter auth header", () => {
  it("sends NO auth header when apiKey is not configured", async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ isValid: true })]);
    const a = makeAdapter({ fetch });
    await a.verify(evmVerifyReq);
    const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
    expect(headers["x-nexus-key"]).toBeUndefined();
    expect(headers["x-secret-key"]).toBeUndefined();
  });

  it("sends x-nexus-key by default when apiKey is set", async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ isValid: true })]);
    const a = makeAdapter({ fetch, apiKey: "nx-key-abc" });
    await a.verify(evmVerifyReq);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-nexus-key"]).toBe("nx-key-abc");
  });

  it("uses configured authHeaderName when set (e.g. x-secret-key for api.thirdweb.com surface)", async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ isValid: true })]);
    const a = makeAdapter({
      fetch,
      apiKey: "tw_secret_xyz",
      authHeaderName: "x-secret-key",
      baseUrl: "https://api.thirdweb.com/v1/payments/x402",
    });
    await a.verify(evmVerifyReq);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-secret-key"]).toBe("tw_secret_xyz");
    expect(headers["x-nexus-key"]).toBeUndefined();
    expect(calls[0]!.url).toBe(
      "https://api.thirdweb.com/v1/payments/x402/verify",
    );
  });
});

describe("ThirdwebX402Adapter /verify", () => {
  it("happy path: parses isValid + payer", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ isValid: true, payer: PAYER }),
    ]);
    const a = makeAdapter({ fetch, apiKey: "k" });
    const r = await a.verify(evmVerifyReq);
    expect(r.valid).toBe(true);
    expect(r.payer).toBe(PAYER);
    expect(calls[0]!.url).toBe("https://nexus-api.thirdweb.com/verify");
  });

  it("forwards the canonical x402 v2 body shape (x402Version, paymentPayload, paymentRequirements)", async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ isValid: true })]);
    const a = makeAdapter({ fetch, apiKey: "k" });
    await a.verify(evmVerifyReq);
    const body = calls[0]!.body as Record<string, unknown>;
    // x402Version is taken verbatim from the payload — Thirdweb advertises
    // /supported with x402Version: 1 even though network ids are CAIP-2.
    expect(body.x402Version).toBe(1);
    const pp = body.paymentPayload as Record<string, unknown>;
    expect(pp.network).toBe(OPTIMISM);
    expect((pp.payload as Record<string, unknown>).signature).toBeDefined();
    const pr = body.paymentRequirements as Record<string, unknown>;
    expect(pr.maxAmountRequired).toBe("1000");
    expect(pr.asset).toBe(OPTIMISM_USDC);
    // /verify must NOT carry waitUntil.
    expect(body.waitUntil).toBeUndefined();
  });

  it("uses invalidMessage as errorMessage when present", async () => {
    const { fetch } = makeFetch([
      jsonResponse({
        isValid: false,
        invalidReason: "invalid_signature",
        invalidMessage: "ecrecover mismatch",
      }),
    ]);
    const a = makeAdapter({ fetch, apiKey: "k" });
    const r = await a.verify(evmVerifyReq);
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("invalid_signature");
    expect(r.errorMessage).toBe("ecrecover mismatch");
  });

  it("falls back to errorMessage then invalidReason as the user-facing message", async () => {
    const { fetch } = makeFetch([
      jsonResponse({
        isValid: false,
        invalidReason: "nonce_already_used",
        errorMessage: "nonce 0x... has been spent",
      }),
    ]);
    const a = makeAdapter({ fetch, apiKey: "k" });
    const r = await a.verify(evmVerifyReq);
    expect(r.errorCode).toBe("nonce_already_used");
    expect(r.errorMessage).toBe("nonce 0x... has been spent");
  });

  it("unknown invalidReason → provider_internal_error + warn", async () => {
    const warn = vi.fn();
    const { fetch } = makeFetch([
      jsonResponse({
        isValid: false,
        invalidReason: "brand_new_thirdweb_code",
        invalidMessage: "details",
      }),
    ]);
    const a = makeAdapter({ fetch, apiKey: "k", logger: { warn } });
    const r = await a.verify(evmVerifyReq);
    expect(r.errorCode).toBe("provider_internal_error");
    expect(r.errorMessage).toBe("details");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("malformed /verify body throws ProviderError(provider_internal_error)", async () => {
    const { fetch } = makeFetch([jsonResponse({ wrong: "shape" })]);
    const a = makeAdapter({ fetch, apiKey: "k" });
    await expect(a.verify(evmVerifyReq)).rejects.toMatchObject({
      name: "ProviderError",
      code: "provider_internal_error",
      providerId: "thirdweb-x402",
    });
  });

  it("translates HTTP 401 to ProviderError(unauthorized) — missing/invalid api key", async () => {
    const { fetch } = makeFetch([
      textResponse(
        JSON.stringify({
          error: "Verification failed",
          message: "'x-nexus-key' header is required.",
        }),
        401,
      ),
    ]);
    const a = makeAdapter({ fetch }); // no apiKey
    await expect(a.verify(evmVerifyReq)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("translates HTTP 429 to ProviderError(rate_limited)", async () => {
    const { fetch } = makeFetch([textResponse("rate limited", 429)]);
    const a = makeAdapter({ fetch, apiKey: "k" });
    await expect(a.verify(evmVerifyReq)).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("translates HTTP 5xx to ProviderError(provider_internal_error)", async () => {
    const { fetch } = makeFetch([textResponse("upstream boom", 502)]);
    const a = makeAdapter({ fetch, apiKey: "k" });
    await expect(a.verify(evmVerifyReq)).rejects.toMatchObject({
      code: "provider_internal_error",
    });
  });
});

describe("ThirdwebX402Adapter /settle", () => {
  it("happy path: returns the EVM tx hash unchanged", async () => {
    const txHash = "0x" + "ab".repeat(32);
    const { fetch } = makeFetch([
      jsonResponse({
        success: true,
        transaction: txHash,
        network: OPTIMISM,
        amount: "1000",
        payer: PAYER,
      }),
    ]);
    const a = makeAdapter({ fetch, apiKey: "k" });
    const r = await a.settle(evmSettleReq);
    expect(r.settled).toBe(true);
    expect(r.txHash).toBe(txHash);
    expect(r.network).toBe(OPTIMISM);
    expect(r.amount).toBe("1000");
    expect(r.payer).toBe(PAYER);
  });

  it("propagates broadcast_failed with errorMessage", async () => {
    const { fetch } = makeFetch([
      jsonResponse({
        success: false,
        errorReason: "broadcast_failed",
        errorMessage: "nonce too low",
        network: OPTIMISM,
      }),
    ]);
    const a = makeAdapter({ fetch, apiKey: "k" });
    const r = await a.settle(evmSettleReq);
    expect(r.settled).toBe(false);
    expect(r.errorCode).toBe("broadcast_failed");
    expect(r.errorMessage).toBe("nonce too low");
  });

  it("falls back to requirements.maxAmountRequired when response omits amount", async () => {
    const { fetch } = makeFetch([
      jsonResponse({ success: true, transaction: "0xdeadbeef" }),
    ]);
    const a = makeAdapter({ fetch, apiKey: "k" });
    const r = await a.settle(evmSettleReq);
    expect(r.amount).toBe("1000");
  });

  it("does NOT send Idempotency-Key by default", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ success: true, transaction: "0xdeadbeef" }),
    ]);
    const a = makeAdapter({ fetch, apiKey: "k" });
    await a.settle(evmSettleReq);
    const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });

  it("propagates Idempotency-Key + retries on 5xx when key is provided", async () => {
    const { fetch, calls } = makeFetch([
      textResponse("upstream gone", 503),
      jsonResponse({ success: true, transaction: "0xdeadbeef" }),
    ]);
    const a = makeAdapter({ fetch, apiKey: "k" });
    const r = await a.settle(evmSettleReq, { idempotencyKey: "idem-tw-123" });
    expect(r.settled).toBe(true);
    expect(calls.length).toBe(2);
    const headers0 = calls[0]!.init.headers as Record<string, string>;
    const headers1 = calls[1]!.init.headers as Record<string, string>;
    expect(headers0["Idempotency-Key"]).toBe("idem-tw-123");
    expect(headers1["Idempotency-Key"]).toBe("idem-tw-123");
  });

  it("forwards waitUntil when configured", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ success: true, transaction: "0xdeadbeef" }),
    ]);
    const a = makeAdapter({ fetch, apiKey: "k", waitUntil: "submitted" });
    await a.settle(evmSettleReq);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.waitUntil).toBe("submitted");
  });

  it("omits waitUntil when not configured (upstream default applies)", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ success: true, transaction: "0xdeadbeef" }),
    ]);
    const a = makeAdapter({ fetch, apiKey: "k" });
    await a.settle(evmSettleReq);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.waitUntil).toBeUndefined();
  });
});

describe("ThirdwebX402Adapter healthCheck", () => {
  it("returns healthy on 200 from /health (open endpoint, no auth)", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({
        status: "ok",
        timestamp: "2026-05-29T02:00:00.000Z",
        database: "connected",
      }),
    ]);
    const a = makeAdapter({ fetch });
    const h = await a.healthCheck();
    expect(h.status).toBe("healthy");
    expect(calls[0]!.url).toBe("https://nexus-api.thirdweb.com/health");
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

describe("ThirdwebX402Adapter discoverCapabilities", () => {
  it("keeps all configured (network, asset) pairs when Thirdweb advertises them", async () => {
    const { fetch } = makeFetch([
      jsonResponse({
        kinds: [
          {
            x402Version: 1,
            scheme: "exact",
            network: OPTIMISM,
            extra: {
              defaultAsset: {
                address: OPTIMISM_USDC,
                decimals: 6,
                eip712: {
                  name: "USD Coin",
                  version: "2",
                  primaryType: "TransferWithAuthorization",
                },
              },
            },
          },
          {
            x402Version: 1,
            scheme: "exact",
            network: ETH_MAINNET,
            extra: {
              defaultAsset: {
                address: ETH_USDC,
                decimals: 6,
                eip712: {
                  name: "USD Coin",
                  version: "2",
                  primaryType: "TransferWithAuthorization",
                },
              },
            },
          },
        ],
      }),
    ]);
    const a = makeAdapter({ fetch });
    const caps = await a.discoverCapabilities();
    expect(caps).toEqual([
      { network: OPTIMISM, asset: OPTIMISM_USDC, scheme: "exact" },
      { network: ETH_MAINNET, asset: ETH_USDC, scheme: "exact" },
    ]);
  });

  it("does NOT filter by x402Version (Thirdweb labels everything as 1 even with CAIP-2 networks)", async () => {
    // Important quirk: PayAI's discoverCapabilities filters out v1
    // because PayAI advertises both v1 (short names) AND v2 (CAIP-2)
    // — keeping v2 only avoids double-registration. Thirdweb only
    // advertises v1 with CAIP-2 networks; filtering by version would
    // discard everything. This test guards that the filter is NOT
    // re-introduced by accident.
    const { fetch } = makeFetch([
      jsonResponse({
        kinds: [
          { x402Version: 1, scheme: "exact", network: OPTIMISM },
        ],
      }),
    ]);
    const a = makeAdapter({ fetch });
    const caps = await a.discoverCapabilities();
    expect(caps).toEqual([
      { network: OPTIMISM, asset: OPTIMISM_USDC, scheme: "exact" },
    ]);
  });

  it("skips entries not present in the static config + warns", async () => {
    const warn = vi.fn();
    const { fetch } = makeFetch([
      jsonResponse({
        kinds: [
          { x402Version: 1, scheme: "exact", network: OPTIMISM },
          // Avalanche — Thirdweb advertises it, but it's not in our
          // static config (PayAI owns that route).
          { x402Version: 1, scheme: "exact", network: "eip155:43114" },
        ],
      }),
    ]);
    const a = makeAdapter({ fetch, logger: { warn } });
    const caps = await a.discoverCapabilities();
    expect(caps.map((c) => c.network)).toEqual([OPTIMISM]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("ignores non-exact schemes (forward-compat for permit2-exact etc.)", async () => {
    const warn = vi.fn();
    const { fetch } = makeFetch([
      jsonResponse({
        kinds: [
          { x402Version: 1, scheme: "exact", network: OPTIMISM },
          // Thirdweb adds permit2-exact later: must not log a warning,
          // must not appear in capabilities.
          { x402Version: 1, scheme: "permit2-exact", network: OPTIMISM },
        ],
      }),
    ]);
    const a = makeAdapter({ fetch, logger: { warn } });
    const caps = await a.discoverCapabilities();
    expect(caps).toEqual([
      { network: OPTIMISM, asset: OPTIMISM_USDC, scheme: "exact" },
    ]);
    // Non-exact schemes are silently ignored (not warned) because they
    // are future-protocol entries, not config mismatches.
    expect(warn).not.toHaveBeenCalled();
  });

  it("throws on malformed /supported body", async () => {
    const { fetch } = makeFetch([jsonResponse({ kinds: "not-an-array" })]);
    const a = makeAdapter({ fetch });
    await expect(a.discoverCapabilities()).rejects.toMatchObject({
      code: "provider_internal_error",
      providerId: "thirdweb-x402",
    });
  });
});

describe("ThirdwebX402Adapter getStatus", () => {
  it("settled when hints carry a txHash", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    expect(
      (await a.getStatus("pay_x", { txHash: "0xabc" })).status,
    ).toBe("settled");
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

describe("ThirdwebX402Adapter URL parsing", () => {
  it("strips a trailing slash from the configured baseUrl", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({
        kinds: [{ x402Version: 1, scheme: "exact", network: OPTIMISM }],
      }),
    ]);
    const a = makeAdapter({
      fetch,
      baseUrl: "https://nexus-api.thirdweb.com/",
    });
    await a.discoverCapabilities();
    expect(calls[0]!.url).toBe("https://nexus-api.thirdweb.com/supported");
  });
});
