import type { SettleRequest, VerifyRequest } from "@suverse-pay/core-types";
import { describe, expect, it, vi } from "vitest";
import {
  BOFAI_SCHEMES,
  BofaiX402Adapter,
  type BofaiCapabilityConfig,
  type BofaiLogger,
} from "./adapter.js";
import { TRON_TOKENS, getTronUsdt } from "./tron-tokens.js";

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

const TRON_MAINNET = "tron:mainnet";
const TRON_USDT_BASE58 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const BSC = "eip155:56";
const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
const PAYER_TRON_BASE58 = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";

const BASE_CAPS: BofaiCapabilityConfig[] = [
  // TRON USDT — three schemes
  { network: TRON_MAINNET, asset: TRON_USDT_BASE58, scheme: "exact" },
  { network: TRON_MAINNET, asset: TRON_USDT_BASE58, scheme: "exact_permit" },
  { network: TRON_MAINNET, asset: TRON_USDT_BASE58, scheme: "exact_gasfree" },
  // BSC USDT — exact + exact_permit
  { network: BSC, asset: BSC_USDT, scheme: "exact" },
  { network: BSC, asset: BSC_USDT, scheme: "exact_permit" },
];

interface AdapterOverrides {
  fetch: typeof globalThis.fetch;
  baseUrl?: string;
  logger?: BofaiLogger;
}

function makeAdapter(o: AdapterOverrides): BofaiX402Adapter {
  return new BofaiX402Adapter({
    capabilities: BASE_CAPS,
    estimatedFeeUsd: "0.001",
    fetchImpl: o.fetch,
    ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
    ...(o.logger !== undefined ? { logger: o.logger } : {}),
  });
}

// TRON-flavored verify/settle req. We don't have signer-tron yet so
// the payload signature is a placeholder; the adapter is wire-only.
const tronVerifyReq: VerifyRequest = {
  paymentPayload: {
    x402Version: 2,
    scheme: "exact_gasfree",
    network: TRON_MAINNET,
    payload: {
      signature: "0x" + "ab".repeat(65),
      // GasFree PermitTransfer authorization, opaque to the adapter.
      gasfreeAuthorization: {
        token: TRON_USDT_BASE58,
        user: PAYER_TRON_BASE58,
        receiver: "TFakeRecipientAddressForTesting1234",
        value: "1000000", // 1 USDT (6 decimals on TRON)
        maxFee: "100000",
        deadline: "9999999999",
        nonce: "42",
      },
    },
  },
  paymentRequirements: {
    scheme: "exact_gasfree",
    network: TRON_MAINNET,
    maxAmountRequired: "1000000",
    asset: TRON_USDT_BASE58,
    payTo: "TFakeRecipientAddressForTesting1234",
    resource: "https://api.example.test/tron",
    maxTimeoutSeconds: 60,
    extra: { name: "Tether USD", version: "1" },
  },
};

const tronSettleReq: SettleRequest = tronVerifyReq;

describe("BofaiX402Adapter basics", () => {
  it("exposes id + default display name + default base URL", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ kinds: [{ x402Version: 2, scheme: "exact", network: TRON_MAINNET }] }),
    ]);
    const a = makeAdapter({ fetch });
    expect(a.id).toBe("bofai-x402");
    expect(a.displayName).toBe("BofAI x402 Facilitator (TRON + BSC)");
    await a.discoverCapabilities();
    expect(calls[0]!.url).toBe("https://facilitator.bankofai.io/supported");
  });

  it("supports() returns true for the TRON USDT capability across all three schemes", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    for (const scheme of BOFAI_SCHEMES) {
      const r = await a.supports({ network: TRON_MAINNET, asset: TRON_USDT_BASE58, scheme });
      expect(r.supported).toBe(true);
    }
  });

  it("supports() returns false for Ethereum (out of scope)", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    const r = await a.supports({
      network: "eip155:1",
      asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      scheme: "exact",
    });
    expect(r.supported).toBe(false);
  });

  it("quote(): synthetic, returns configured fee", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    const q = await a.quote({
      network: TRON_MAINNET,
      asset: TRON_USDT_BASE58,
      amount: "1000000",
      scheme: "exact",
    });
    expect(q.source).toBe("synthetic");
    expect(q.estimatedFeeUsd).toBe("0.001");
    expect(q.providerId).toBe("bofai-x402");
  });
});

describe("BofaiX402Adapter no-auth", () => {
  it("sends NO Authorization header (BofAI is open since v0.6.0)", async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ isValid: true })]);
    const a = makeAdapter({ fetch });
    await a.verify(tronVerifyReq);
    const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["authorization"]).toBeUndefined();
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["x-secret-key"]).toBeUndefined();
  });
});

describe("BofaiX402Adapter /verify", () => {
  it("happy path: parses isValid + payer", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ isValid: true, payer: PAYER_TRON_BASE58 }),
    ]);
    const a = makeAdapter({ fetch });
    const r = await a.verify(tronVerifyReq);
    expect(r.valid).toBe(true);
    expect(r.payer).toBe(PAYER_TRON_BASE58);
    expect(calls[0]!.url).toBe("https://facilitator.bankofai.io/verify");
  });

  it("forwards vanilla x402 v2 body shape verbatim (no envelope)", async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ isValid: true })]);
    const a = makeAdapter({ fetch });
    await a.verify(tronVerifyReq);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.x402Version).toBe(2);
    const pp = body.paymentPayload as Record<string, unknown>;
    expect(pp.network).toBe(TRON_MAINNET);
    expect(pp.scheme).toBe("exact_gasfree");
    const pr = body.paymentRequirements as Record<string, unknown>;
    expect(pr.asset).toBe(TRON_USDT_BASE58);
    // TRON Base58 address survives the round-trip unmolested.
    expect((pr.asset as string).startsWith("T")).toBe(true);
    expect((pr.asset as string).length).toBe(34);
  });

  it("maps GasFree-specific gasfree_inactive_account error", async () => {
    const { fetch } = makeFetch([
      jsonResponse({
        isValid: false,
        invalidReason: "gasfree_inactive_account",
        invalidMessage: "user's gasFreeAddress has not been activated yet",
      }),
    ]);
    const a = makeAdapter({ fetch });
    const r = await a.verify(tronVerifyReq);
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("invalid_authorization");
    expect(r.errorMessage).toBe("user's gasFreeAddress has not been activated yet");
  });

  it("maps energy_exhausted (TRON-specific) → broadcast_failed", async () => {
    const { fetch } = makeFetch([
      jsonResponse({
        isValid: false,
        invalidReason: "energy_exhausted",
        invalidMessage: "TRON energy / bandwidth insufficient",
      }),
    ]);
    const a = makeAdapter({ fetch });
    const r = await a.verify(tronVerifyReq);
    expect(r.errorCode).toBe("broadcast_failed");
  });

  it("unknown reason → provider_internal_error + warn", async () => {
    const warn = vi.fn();
    const { fetch } = makeFetch([
      jsonResponse({
        isValid: false,
        invalidReason: "brand_new_bofai_code",
        invalidMessage: "x",
      }),
    ]);
    const a = makeAdapter({ fetch, logger: { warn } });
    const r = await a.verify(tronVerifyReq);
    expect(r.errorCode).toBe("provider_internal_error");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("malformed body → ProviderError(provider_internal_error)", async () => {
    const { fetch } = makeFetch([jsonResponse({ wrong: "shape" })]);
    const a = makeAdapter({ fetch });
    await expect(a.verify(tronVerifyReq)).rejects.toMatchObject({
      name: "ProviderError",
      code: "provider_internal_error",
      providerId: "bofai-x402",
    });
  });

  it("HTTP 5xx → ProviderError(provider_internal_error) with status", async () => {
    const { fetch } = makeFetch([textResponse("upstream gone", 502)]);
    const a = makeAdapter({ fetch });
    await expect(a.verify(tronVerifyReq)).rejects.toMatchObject({
      code: "provider_internal_error",
    });
  });
});

describe("BofaiX402Adapter /settle", () => {
  it("happy path on TRON: returns the 64-char hex tx id unchanged", async () => {
    const tronTxId = "f".repeat(64); // TRON tx ids are 64 hex chars, NO 0x prefix
    const { fetch } = makeFetch([
      jsonResponse({
        success: true,
        transaction: tronTxId,
        network: TRON_MAINNET,
        amount: "1000000",
        payer: PAYER_TRON_BASE58,
      }),
    ]);
    const a = makeAdapter({ fetch });
    const r = await a.settle(tronSettleReq);
    expect(r.settled).toBe(true);
    expect(r.txHash).toBe(tronTxId);
    // 64 chars, no 0x prefix — proves TRON tx hashes survive the
    // round-trip distinct from EVM (which would have 0x + 64).
    expect(r.txHash!.length).toBe(64);
    expect(r.txHash!.startsWith("0x")).toBe(false);
  });

  it("propagates failure with errorCode", async () => {
    const { fetch } = makeFetch([
      jsonResponse({
        success: false,
        errorReason: "insufficient_gasfree_balance",
        errorMessage: "gasFreeAddress balance < amount + maxFee",
      }),
    ]);
    const a = makeAdapter({ fetch });
    const r = await a.settle(tronSettleReq);
    expect(r.settled).toBe(false);
    expect(r.errorCode).toBe("insufficient_funds");
  });

  it("propagates Idempotency-Key + retries on 5xx", async () => {
    const { fetch, calls } = makeFetch([
      textResponse("upstream gone", 503),
      jsonResponse({ success: true, transaction: "deadbeef".repeat(8) }),
    ]);
    const a = makeAdapter({ fetch });
    const r = await a.settle(tronSettleReq, { idempotencyKey: "idem-tron-1" });
    expect(r.settled).toBe(true);
    expect(calls.length).toBe(2);
    const h0 = calls[0]!.init.headers as Record<string, string>;
    const h1 = calls[1]!.init.headers as Record<string, string>;
    expect(h0["Idempotency-Key"]).toBe("idem-tron-1");
    expect(h1["Idempotency-Key"]).toBe("idem-tron-1");
  });

  it("falls back to requirements.maxAmountRequired when response omits amount", async () => {
    const { fetch } = makeFetch([
      jsonResponse({ success: true, transaction: "f".repeat(64) }),
    ]);
    const a = makeAdapter({ fetch });
    const r = await a.settle(tronSettleReq);
    expect(r.amount).toBe("1000000");
  });
});

describe("BofaiX402Adapter healthCheck", () => {
  it("returns healthy on 200 from /health (no auth needed)", async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ status: "ok" })]);
    const a = makeAdapter({ fetch });
    const h = await a.healthCheck();
    expect(h.status).toBe("healthy");
    expect(calls[0]!.url).toBe("https://facilitator.bankofai.io/health");
  });

  it("returns down on 5xx", async () => {
    const { fetch } = makeFetch([textResponse("upstream gone", 502)]);
    const a = makeAdapter({ fetch });
    const h = await a.healthCheck();
    expect(h.status).toBe("down");
    expect(h.error).toContain("502");
  });
});

describe("BofaiX402Adapter discoverCapabilities", () => {
  it("keeps all configured (network, scheme) pairs and skips unknown ones with a warning", async () => {
    const warn = vi.fn();
    const { fetch } = makeFetch([
      jsonResponse({
        kinds: [
          { x402Version: 2, scheme: "exact", network: TRON_MAINNET },
          { x402Version: 2, scheme: "exact_permit", network: TRON_MAINNET },
          { x402Version: 2, scheme: "exact_gasfree", network: TRON_MAINNET },
          { x402Version: 2, scheme: "exact", network: BSC },
          // Shasta testnet — adapter has no shasta asset configured.
          { x402Version: 2, scheme: "exact", network: "tron:shasta" },
        ],
      }),
    ]);
    const a = makeAdapter({ fetch, logger: { warn } });
    const caps = await a.discoverCapabilities();
    expect(caps.map((c) => `${c.network}:${c.scheme}`).sort()).toEqual(
      [
        `${TRON_MAINNET}:exact`,
        `${TRON_MAINNET}:exact_permit`,
        `${TRON_MAINNET}:exact_gasfree`,
        `${BSC}:exact`,
      ].sort(),
    );
    expect(warn).toHaveBeenCalledOnce();
  });

  it("throws on malformed /supported body", async () => {
    const { fetch } = makeFetch([jsonResponse({ kinds: "not-an-array" })]);
    const a = makeAdapter({ fetch });
    await expect(a.discoverCapabilities()).rejects.toMatchObject({
      code: "provider_internal_error",
      providerId: "bofai-x402",
    });
  });
});

describe("BofaiX402Adapter getStatus", () => {
  it("settled when hints carry a txHash", async () => {
    const { fetch } = makeFetch([]);
    const a = makeAdapter({ fetch });
    const s = await a.getStatus("pay_x", { txHash: "f".repeat(64) });
    expect(s.status).toBe("settled");
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

describe("TRON token registry", () => {
  it("registers USDT on all three TRON networks BofAI advertises", () => {
    expect(TRON_TOKENS.map((t) => t.network).sort()).toEqual(
      ["tron:mainnet", "tron:nile", "tron:shasta"].sort(),
    );
    for (const t of TRON_TOKENS) {
      expect(t.symbol).toBe("USDT");
      expect(t.decimals).toBe(6); // TRON USDT is 6 decimals, NOT 18 like BSC
      expect(t.addressBase58.startsWith("T")).toBe(true);
      expect(t.addressBase58.length).toBe(34);
    }
  });

  it("getTronUsdt returns canonical mainnet USDT contract", () => {
    const usdt = getTronUsdt("tron:mainnet");
    expect(usdt?.addressBase58).toBe("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
    expect(usdt?.decimals).toBe(6);
  });

  it("getTronUsdt returns null for unknown TRON network", () => {
    expect(getTronUsdt("tron:fake")).toBeNull();
  });
});
