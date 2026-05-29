import type { SettleRequest, VerifyRequest } from "@suverse-pay/core-types";
import { describe, expect, it, vi } from "vitest";
import {
  BinanceX402Adapter,
  type BinanceCapabilityConfig,
  type BinanceLogger,
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

const BNB_CHAIN = "eip155:56";
const BSC_USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
const PAYER = "0xA2F8a871AfDC463aaEf5FAe8284d900f4d02538E";

const BASE_CAPS: BinanceCapabilityConfig[] = [
  { network: BNB_CHAIN, asset: BSC_USDC, scheme: "exact", assetTransferMethod: "permit2-exact" },
  { network: BNB_CHAIN, asset: BSC_USDT, scheme: "exact", assetTransferMethod: "permit2-exact" },
];

interface AdapterOverrides {
  fetch: typeof globalThis.fetch;
  apiKeyId?: string;
  apiSecret?: string;
  baseUrl?: string;
  pathPrefix?: string;
  logger?: BinanceLogger;
}

function makeAdapter(o: AdapterOverrides): BinanceX402Adapter {
  return new BinanceX402Adapter({
    capabilities: BASE_CAPS,
    estimatedFeeUsd: "0.001",
    fetchImpl: o.fetch,
    ...(o.apiKeyId !== undefined ? { apiKeyId: o.apiKeyId } : {}),
    ...(o.apiSecret !== undefined ? { apiSecret: o.apiSecret } : {}),
    ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
    ...(o.pathPrefix !== undefined ? { pathPrefix: o.pathPrefix } : {}),
    ...(o.logger !== undefined ? { logger: o.logger } : {}),
  });
}

const verifyReq: VerifyRequest = {
  paymentPayload: {
    x402Version: 2,
    scheme: "exact",
    network: BNB_CHAIN,
    payload: {
      signature: "0x" + "ab".repeat(65),
      permit2Authorization: {
        permitted: { token: BSC_USDT, amount: "1000000000000000000" }, // 1 USDT, 18 decimals!
        from: PAYER,
        spender: "0x402085c248EeA27D92E8b30b2C58ed07f9E20001",
        nonce: "12345",
        deadline: "9999999999",
        witness: { to: "0x000000000000000000000000000000000000bEEF", validAfter: "0" },
      },
    },
  },
  paymentRequirements: {
    scheme: "exact",
    network: BNB_CHAIN,
    maxAmountRequired: "1000000000000000000",
    asset: BSC_USDT,
    payTo: "0x000000000000000000000000000000000000bEEF",
    resource: "https://api.example.test/bnb",
    maxTimeoutSeconds: 60,
    extra: { assetTransferMethod: "permit2-exact" },
  },
};

const settleReq: SettleRequest = verifyReq;

describe("BinanceX402Adapter basics", () => {
  it("exposes id + display name + default URL composition", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ kinds: [{ x402Version: 2, scheme: "exact", network: BNB_CHAIN }] }),
    ]);
    const a = makeAdapter({ fetch, apiKeyId: "k", apiSecret: "s" });
    expect(a.id).toBe("binance-x402");
    expect(a.displayName).toBe("Binance x402 Facilitator (BNB Chain)");
    await a.discoverCapabilities();
    expect(calls[0]!.url).toBe(
      "https://bpay.binanceapi.com/binancepay/openapi/v1/x402/supported",
    );
  });

  it("respects custom baseUrl + pathPrefix (Binance may publish a different mount point)", async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ kinds: [] })]);
    const a = makeAdapter({
      fetch,
      apiKeyId: "k",
      apiSecret: "s",
      baseUrl: "https://custom.binance.api/",
      pathPrefix: "v2/x402/",
    });
    await a.discoverCapabilities();
    expect(calls[0]!.url).toBe("https://custom.binance.api/v2/x402/supported");
  });

  it("supports(): true for the configured BNB Chain USDT route", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    expect(
      await a.supports({ network: BNB_CHAIN, asset: BSC_USDT, scheme: "exact" }),
    ).toEqual({ supported: true });
  });

  it("supports(): false for non-BSC networks", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    expect(
      (
        await a.supports({
          network: "eip155:1",
          asset: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
          scheme: "exact",
        })
      ).supported,
    ).toBe(false);
  });

  it("quote(): synthetic, returns configured fee", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    const q = await a.quote({
      network: BNB_CHAIN,
      asset: BSC_USDT,
      amount: "1000000000000000000",
      scheme: "exact",
    });
    expect(q.source).toBe("synthetic");
    expect(q.estimatedFeeUsd).toBe("0.001");
    expect(q.providerId).toBe("binance-x402");
  });
});

describe("BinanceX402Adapter credential gating", () => {
  it("throws unauthorized on /verify without credentials", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    await expect(a.verify(verifyReq)).rejects.toMatchObject({
      name: "ProviderError",
      code: "unauthorized",
      providerId: "binance-x402",
    });
  });

  it("throws unauthorized on /settle without credentials", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    await expect(a.settle(settleReq)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("throws unauthorized on discoverCapabilities without credentials", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    await expect(a.discoverCapabilities()).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
});

describe("BinanceX402Adapter signed requests", () => {
  it("/verify sends BinancePay-* headers + vanilla x402 v2 body", async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ isValid: true })]);
    const a = makeAdapter({ fetch, apiKeyId: "merch_id", apiSecret: "merch_sec" });
    await a.verify(verifyReq);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["BinancePay-Certificate-SN"]).toBe("merch_id");
    expect(headers["BinancePay-Timestamp"]).toMatch(/^\d{13}$/);
    expect(headers["BinancePay-Nonce"]).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(headers["BinancePay-Signature"]).toMatch(/^[0-9A-F]{128}$/);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.x402Version).toBe(2);
    const pp = body.paymentPayload as Record<string, unknown>;
    expect(pp.network).toBe(BNB_CHAIN);
  });

  it("/verify happy path: parses isValid + payer", async () => {
    const { fetch } = makeFetch([
      jsonResponse({ isValid: true, payer: PAYER }),
    ]);
    const a = makeAdapter({ fetch, apiKeyId: "id", apiSecret: "s" });
    const r = await a.verify(verifyReq);
    expect(r.valid).toBe(true);
    expect(r.payer).toBe(PAYER);
  });

  it("/verify maps invalid_signature → ProviderError code", async () => {
    const { fetch } = makeFetch([
      jsonResponse({
        isValid: false,
        invalidReason: "invalid_signature",
        invalidMessage: "HMAC mismatch",
      }),
    ]);
    const a = makeAdapter({ fetch, apiKeyId: "id", apiSecret: "s" });
    const r = await a.verify(verifyReq);
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("invalid_signature");
    expect(r.errorMessage).toBe("HMAC mismatch");
  });

  it("/verify maps Binance-Pay-specific code certificate_sn_invalid → unauthorized", async () => {
    const { fetch } = makeFetch([
      jsonResponse({
        isValid: false,
        invalidReason: "certificate_sn_invalid",
        invalidMessage: "merchant key not found",
      }),
    ]);
    const a = makeAdapter({ fetch, apiKeyId: "id", apiSecret: "s" });
    const r = await a.verify(verifyReq);
    expect(r.errorCode).toBe("unauthorized");
  });

  it("/verify unknown error reason → provider_internal_error + warn", async () => {
    const warn = vi.fn();
    const { fetch } = makeFetch([
      jsonResponse({
        isValid: false,
        invalidReason: "brand_new_binance_code",
        invalidMessage: "x",
      }),
    ]);
    const a = makeAdapter({
      fetch,
      apiKeyId: "id",
      apiSecret: "s",
      logger: { warn },
    });
    const r = await a.verify(verifyReq);
    expect(r.errorCode).toBe("provider_internal_error");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("/settle happy path: returns tx hash + 18-decimal amount unchanged", async () => {
    const oneUsdt = "1000000000000000000"; // 1 USDT on BSC = 1 * 10^18
    const tx = "0x" + "cd".repeat(32);
    const { fetch } = makeFetch([
      jsonResponse({
        success: true,
        transaction: tx,
        network: BNB_CHAIN,
        amount: oneUsdt,
        payer: PAYER,
      }),
    ]);
    const a = makeAdapter({ fetch, apiKeyId: "id", apiSecret: "s" });
    const r = await a.settle(settleReq);
    expect(r.settled).toBe(true);
    expect(r.txHash).toBe(tx);
    expect(r.amount).toBe(oneUsdt);
    expect(r.asset).toBe(BSC_USDT);
  });

  it("/settle: 5xx retries + propagates Idempotency-Key", async () => {
    const { fetch, calls } = makeFetch([
      textResponse("upstream gone", 503),
      jsonResponse({ success: true, transaction: "0xdead" }),
    ]);
    const a = makeAdapter({ fetch, apiKeyId: "id", apiSecret: "s" });
    const r = await a.settle(settleReq, { idempotencyKey: "idem-bnc-1" });
    expect(r.settled).toBe(true);
    expect(calls.length).toBe(2);
    const h0 = calls[0]!.init.headers as Record<string, string>;
    const h1 = calls[1]!.init.headers as Record<string, string>;
    expect(h0["Idempotency-Key"]).toBe("idem-bnc-1");
    expect(h1["Idempotency-Key"]).toBe("idem-bnc-1");
    // Headers are computed ONCE per logical request — both attempts
    // re-send the same signature, nonce, and Idempotency-Key. That's
    // by design: Binance Pay's HMAC scheme has no per-attempt
    // freshness requirement (the Idempotency-Key + signature form
    // the de-dup key), so retrying the identical payload is the
    // right semantic. The signed headers must still be present + valid.
    expect(h0["BinancePay-Signature"]).toMatch(/^[0-9A-F]{128}$/);
    expect(h1["BinancePay-Signature"]).toMatch(/^[0-9A-F]{128}$/);
  });

  it("/settle HTTP 401 → ProviderError(unauthorized)", async () => {
    const { fetch } = makeFetch([textResponse("bad signature", 401)]);
    const a = makeAdapter({ fetch, apiKeyId: "id", apiSecret: "s" });
    await expect(a.settle(settleReq)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("/settle HTTP 429 → ProviderError(rate_limited)", async () => {
    const { fetch } = makeFetch([textResponse("slow down", 429)]);
    const a = makeAdapter({ fetch, apiKeyId: "id", apiSecret: "s" });
    await expect(a.settle(settleReq)).rejects.toMatchObject({
      code: "rate_limited",
    });
  });
});

describe("BinanceX402Adapter healthCheck", () => {
  it("returns healthy on 200 from /supported, even without credentials (Binance may surface a 401 — captured as down)", async () => {
    const { fetch } = makeFetch([
      jsonResponse({ kinds: [{ x402Version: 2, scheme: "exact", network: BNB_CHAIN }] }),
    ]);
    const a = makeAdapter({ fetch }); // no creds
    const h = await a.healthCheck();
    expect(h.status).toBe("healthy");
  });

  it("returns down on 401 (creds missing or wrong)", async () => {
    const { fetch } = makeFetch([textResponse("auth required", 401)]);
    const a = makeAdapter({ fetch });
    const h = await a.healthCheck();
    expect(h.status).toBe("down");
    expect(h.error).toContain("401");
  });
});

describe("BinanceX402Adapter discoverCapabilities", () => {
  it("filters /supported to configured assets + signs the GET request", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({
        kinds: [
          { x402Version: 2, scheme: "exact", network: BNB_CHAIN },
          // Some hypothetical Binance entry for a network we don't
          // statically advertise — should be skipped with a warning.
          { x402Version: 2, scheme: "exact", network: "eip155:97" },
        ],
      }),
    ]);
    const warn = vi.fn();
    const a = makeAdapter({
      fetch,
      apiKeyId: "id",
      apiSecret: "s",
      logger: { warn },
    });
    const caps = await a.discoverCapabilities();
    expect(caps.map((c) => `${c.network}:${c.asset}`).sort()).toEqual([
      `${BNB_CHAIN}:${BSC_USDC}`,
      `${BNB_CHAIN}:${BSC_USDT}`,
    ].sort());
    expect(warn).toHaveBeenCalledOnce();
    // The GET request was signed.
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["BinancePay-Certificate-SN"]).toBe("id");
    expect(headers["BinancePay-Signature"]).toMatch(/^[0-9A-F]{128}$/);
  });
});

describe("BinanceX402Adapter 18-decimal sanity", () => {
  // The whole motivation for this test block: BSC stablecoins use 18
  // decimals, not 6 like every other USDC/USDT we route. The adapter
  // is amount-format-agnostic (it forwards strings), but the wire
  // path has to preserve 18-decimal big-integer literals correctly.
  it("/settle forwards an 18-decimal amount verbatim ($1.00 USDT = 1e18)", async () => {
    const oneUsdt = "1000000000000000000"; // exactly 10^18
    const req: SettleRequest = {
      paymentPayload: {
        ...settleReq.paymentPayload,
        payload: {
          ...(settleReq.paymentPayload.payload as Record<string, unknown>),
          permit2Authorization: {
            ...(
              (settleReq.paymentPayload.payload as Record<string, unknown>)[
                "permit2Authorization"
              ] as Record<string, unknown>
            ),
            permitted: { token: BSC_USDT, amount: oneUsdt },
          },
        },
      },
      paymentRequirements: {
        ...settleReq.paymentRequirements,
        maxAmountRequired: oneUsdt,
      },
    };
    const { fetch, calls } = makeFetch([
      jsonResponse({ success: true, transaction: "0xtx", amount: oneUsdt }),
    ]);
    const a = makeAdapter({ fetch, apiKeyId: "id", apiSecret: "s" });
    const r = await a.settle(req);
    expect(r.amount).toBe(oneUsdt);
    // Confirm the wire body carries the 18-decimal literal — we did
    // not silently truncate via JS Number coercion.
    const body = calls[0]!.body as Record<string, unknown>;
    const pr = body.paymentRequirements as Record<string, unknown>;
    expect(pr.maxAmountRequired).toBe(oneUsdt);
    // Sanity: the literal has exactly 19 characters (1 + 18 zeros),
    // proving we didn't drop precision below uint256.
    expect((pr.maxAmountRequired as string).length).toBe(19);
  });

  it("falls back to requirements.maxAmountRequired (18-dec) when response omits amount", async () => {
    const fivedollarsBsc = "5000000000000000000"; // 5 USDT
    const req: SettleRequest = {
      ...settleReq,
      paymentRequirements: {
        ...settleReq.paymentRequirements,
        maxAmountRequired: fivedollarsBsc,
      },
    };
    const { fetch } = makeFetch([
      jsonResponse({ success: true, transaction: "0xtx" }),
    ]);
    const a = makeAdapter({ fetch, apiKeyId: "id", apiSecret: "s" });
    const r = await a.settle(req);
    expect(r.amount).toBe(fivedollarsBsc);
  });
});

describe("BinanceX402Adapter getStatus", () => {
  it("settled when hints carry a txHash", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    expect((await a.getStatus("pay_x", { txHash: "0xabc" })).status).toBe(
      "settled",
    );
  });
  it("failed when hints carry an errorCode", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    expect(
      (await a.getStatus("pay_x", { errorCode: "broadcast_failed" })).status,
    ).toBe("failed");
  });
  it("pending when no hints", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    expect((await a.getStatus("pay_x")).status).toBe("pending");
  });
});
