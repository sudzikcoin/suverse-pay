import type { SettleRequest, VerifyRequest } from "@suverse-pay/core-types";
import { describe, expect, it, vi } from "vitest";
import {
  T402IoAdapter,
  T402_SCHEMES,
  type T402CapabilityConfig,
  type T402Logger,
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

const NOBLE_MAINNET = "cosmos:noble-1";
const NOBLE_USDT = "uusdt";
const ETH = "eip155:1";
const ETH_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

const BASE_CAPS: T402CapabilityConfig[] = [
  { network: NOBLE_MAINNET, asset: NOBLE_USDT, scheme: "exact" },
  { network: ETH, asset: ETH_USDT, scheme: "exact" },
];

interface AdapterOverrides {
  fetch: typeof globalThis.fetch;
  apiKey?: string;
  baseUrl?: string;
  logger?: T402Logger;
}

function makeAdapter(o: AdapterOverrides): T402IoAdapter {
  return new T402IoAdapter({
    capabilities: BASE_CAPS,
    estimatedFeeUsd: "0.001",
    fetchImpl: o.fetch,
    ...(o.apiKey !== undefined ? { apiKey: o.apiKey } : {}),
    ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
    ...(o.logger !== undefined ? { logger: o.logger } : {}),
  });
}

const verifyReq: VerifyRequest = {
  paymentPayload: {
    x402Version: 2,
    scheme: "exact",
    network: NOBLE_MAINNET,
    payload: {
      signature: "stub",
      authorization: { value: "1000000" },
    },
  },
  paymentRequirements: {
    scheme: "exact",
    network: NOBLE_MAINNET,
    maxAmountRequired: "1000000",
    asset: NOBLE_USDT,
    payTo: "noble1recipient",
    resource: "https://api.example.test/noble",
    maxTimeoutSeconds: 60,
    extra: { decimals: 6 },
  },
};
const settleReq: SettleRequest = verifyReq;

describe("T402IoAdapter basics", () => {
  it("exposes id + default display + base URL", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ kinds: [{ t402Version: 2, scheme: "exact", network: NOBLE_MAINNET }] }),
    ]);
    const a = makeAdapter({ fetch });
    expect(a.id).toBe("t402-io");
    expect(a.displayName).toBe("t402-io Universal USDT Facilitator");
    await a.discoverCapabilities();
    expect(calls[0]!.url).toBe("https://facilitator.t402.io/supported");
  });

  it("advertises the 4 documented schemes via T402_SCHEMES constant", () => {
    expect(T402_SCHEMES).toEqual(["exact", "exact-direct", "exact-legacy", "upto"]);
  });

  it("supports() matches configured caps", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    expect(
      await a.supports({ network: NOBLE_MAINNET, asset: NOBLE_USDT, scheme: "exact" }),
    ).toEqual({ supported: true });
    expect(
      (await a.supports({ network: NOBLE_MAINNET, asset: "uatom", scheme: "exact" })).supported,
    ).toBe(false);
  });

  it("quote(): synthetic, returns configured fee", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    const q = await a.quote({
      network: NOBLE_MAINNET,
      asset: NOBLE_USDT,
      amount: "1000000",
      scheme: "exact",
    });
    expect(q.source).toBe("synthetic");
    expect(q.estimatedFeeUsd).toBe("0.001");
    expect(q.providerId).toBe("t402-io");
  });
});

describe("T402IoAdapter API-key gating", () => {
  it("throws unauthorized on /verify without an API key", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    await expect(a.verify(verifyReq)).rejects.toMatchObject({
      name: "ProviderError",
      code: "unauthorized",
      providerId: "t402-io",
    });
  });

  it("throws unauthorized on /settle without an API key", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    await expect(a.settle(settleReq)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("sends X-API-Key header when an apiKey is configured", async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ isValid: true })]);
    const a = makeAdapter({ fetch, apiKey: "tkey_abc" });
    await a.verify(verifyReq);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("tkey_abc");
  });
});

describe("T402IoAdapter wire body", () => {
  it("emits BOTH t402Version AND x402Version on verify/settle (compat)", async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ isValid: true })]);
    const a = makeAdapter({ fetch, apiKey: "k" });
    await a.verify(verifyReq);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.t402Version).toBe(2);
    expect(body.x402Version).toBe(2);
  });

  it("forwards paymentPayload + paymentRequirements verbatim", async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ isValid: true })]);
    const a = makeAdapter({ fetch, apiKey: "k" });
    await a.verify(verifyReq);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.paymentPayload).toEqual(verifyReq.paymentPayload);
    expect(body.paymentRequirements).toEqual(verifyReq.paymentRequirements);
  });
});

describe("T402IoAdapter /verify error paths", () => {
  it("malformed body → ProviderError(provider_internal_error)", async () => {
    const { fetch } = makeFetch([jsonResponse({ wrong: "shape" })]);
    const a = makeAdapter({ fetch, apiKey: "k" });
    await expect(a.verify(verifyReq)).rejects.toMatchObject({
      code: "provider_internal_error",
      providerId: "t402-io",
    });
  });

  it("maps invalid_signature error code", async () => {
    const { fetch } = makeFetch([
      jsonResponse({
        isValid: false,
        invalidReason: "invalid_signature",
        invalidMessage: "ed25519 verification failed",
      }),
    ]);
    const a = makeAdapter({ fetch, apiKey: "k" });
    const r = await a.verify(verifyReq);
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("invalid_signature");
    expect(r.errorMessage).toBe("ed25519 verification failed");
  });

  it("maps multi-VM error codes (jetton_transfer_failed → broadcast_failed)", async () => {
    const { fetch } = makeFetch([
      jsonResponse({
        isValid: false,
        invalidReason: "jetton_transfer_failed",
        invalidMessage: "TON jetton routing failed",
      }),
    ]);
    const a = makeAdapter({ fetch, apiKey: "k" });
    const r = await a.verify(verifyReq);
    expect(r.errorCode).toBe("broadcast_failed");
  });

  it("unknown reason → provider_internal_error + warn", async () => {
    const warn = vi.fn();
    const { fetch } = makeFetch([
      jsonResponse({
        isValid: false,
        invalidReason: "brand_new_t402_code",
        invalidMessage: "x",
      }),
    ]);
    const a = makeAdapter({ fetch, apiKey: "k", logger: { warn } });
    const r = await a.verify(verifyReq);
    expect(r.errorCode).toBe("provider_internal_error");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("HTTP 401 → ProviderError(unauthorized)", async () => {
    const { fetch } = makeFetch([
      textResponse(
        '{"error":"unauthorized","message":"API key required..."}',
        401,
      ),
    ]);
    const a = makeAdapter({ fetch, apiKey: "bad_key" });
    await expect(a.verify(verifyReq)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
});

describe("T402IoAdapter /settle", () => {
  it("happy path: returns tx hash unchanged", async () => {
    const tronStyleTx = "f".repeat(64);
    const { fetch } = makeFetch([
      jsonResponse({
        success: true,
        transaction: tronStyleTx,
        network: NOBLE_MAINNET,
        amount: "1000000",
      }),
    ]);
    const a = makeAdapter({ fetch, apiKey: "k" });
    const r = await a.settle(settleReq);
    expect(r.settled).toBe(true);
    expect(r.txHash).toBe(tronStyleTx);
  });

  it("propagates Idempotency-Key + retries on 5xx", async () => {
    const { fetch, calls } = makeFetch([
      textResponse("upstream gone", 503),
      jsonResponse({ success: true, transaction: "tx-1" }),
    ]);
    const a = makeAdapter({ fetch, apiKey: "k" });
    const r = await a.settle(settleReq, { idempotencyKey: "idem-t402-1" });
    expect(r.settled).toBe(true);
    expect(calls.length).toBe(2);
    const h0 = calls[0]!.init.headers as Record<string, string>;
    const h1 = calls[1]!.init.headers as Record<string, string>;
    expect(h0["Idempotency-Key"]).toBe("idem-t402-1");
    expect(h1["Idempotency-Key"]).toBe("idem-t402-1");
    // X-API-Key persists across retries.
    expect(h0["X-API-Key"]).toBe("k");
    expect(h1["X-API-Key"]).toBe("k");
  });
});

describe("T402IoAdapter healthCheck", () => {
  it("returns healthy on 200 from /health (open endpoint)", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ status: "healthy", version: "dev" }),
    ]);
    const a = makeAdapter({ fetch });
    const h = await a.healthCheck();
    expect(h.status).toBe("healthy");
    expect(calls[0]!.url).toBe("https://facilitator.t402.io/health");
    // No auth header sent on /health (open endpoint).
    const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
    expect(headers["X-API-Key"]).toBeUndefined();
  });

  it("returns down on 5xx", async () => {
    const { fetch } = makeFetch([textResponse("upstream gone", 502)]);
    const a = makeAdapter({ fetch });
    const h = await a.healthCheck();
    expect(h.status).toBe("down");
    expect(h.error).toContain("502");
  });
});

describe("T402IoAdapter discoverCapabilities", () => {
  it("filters /supported entries against the static config + warns on unknowns", async () => {
    const warn = vi.fn();
    const { fetch } = makeFetch([
      jsonResponse({
        kinds: [
          { t402Version: 2, scheme: "exact", network: NOBLE_MAINNET },
          { t402Version: 2, scheme: "exact", network: ETH },
          // Aptos — adapter has no aptos cap, should be skipped + warn.
          { t402Version: 2, scheme: "exact", network: "aptos:1" },
        ],
      }),
    ]);
    const a = makeAdapter({ fetch, logger: { warn } });
    const caps = await a.discoverCapabilities();
    expect(caps.map((c) => c.network).sort()).toEqual([ETH, NOBLE_MAINNET].sort());
    expect(warn).toHaveBeenCalledOnce();
  });

  it("works without an API key (/supported is open)", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ kinds: [{ t402Version: 2, scheme: "exact", network: NOBLE_MAINNET }] }),
    ]);
    const a = makeAdapter({ fetch });
    await a.discoverCapabilities();
    const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
    expect(headers["X-API-Key"]).toBeUndefined();
  });

  it("throws on malformed body", async () => {
    const { fetch } = makeFetch([jsonResponse({ kinds: "not-an-array" })]);
    const a = makeAdapter({ fetch });
    await expect(a.discoverCapabilities()).rejects.toMatchObject({
      code: "provider_internal_error",
    });
  });
});
