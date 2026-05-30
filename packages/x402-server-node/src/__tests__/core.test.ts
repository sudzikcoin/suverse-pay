/**
 * Unit tests for the framework-agnostic protocol core. The framework
 * adapters are covered by integration tests in core-integration.test.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildChallenge,
  decodePaymentHeader,
  matchRequirement,
  runProtocol,
  validateOptions,
} from "../core.js";
import { X402Error, type MiddlewareOptions } from "../types.js";

const BASE_OPTS: MiddlewareOptions = {
  apiKey: "sup_live_testtesttesttesttesttesttest",
  facilitator: "https://facilitator.example.com",
  acceptedPayments: [
    {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0",
      maxAmountRequired: "100000",
    },
  ],
  description: "test",
};

// Helper: build a base64-encoded X-Payment header from a JS object.
function encodeHeader(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

afterEach(() => vi.restoreAllMocks());

describe("validateOptions", () => {
  it("accepts a well-formed config", () => {
    expect(() => validateOptions(BASE_OPTS)).not.toThrow();
  });
  it("rejects empty apiKey", () => {
    expect(() => validateOptions({ ...BASE_OPTS, apiKey: "" })).toThrowError(
      X402Error,
    );
  });
  it("rejects empty acceptedPayments", () => {
    expect(() =>
      validateOptions({ ...BASE_OPTS, acceptedPayments: [] }),
    ).toThrowError(X402Error);
  });
  it("rejects an acceptedPayments entry missing payTo", () => {
    expect(() =>
      validateOptions({
        ...BASE_OPTS,
        acceptedPayments: [
          // @ts-expect-error -- intentional: testing runtime guard.
          { scheme: "exact", network: "eip155:8453", asset: "0x", maxAmountRequired: "100000" },
        ],
      }),
    ).toThrowError(X402Error);
  });
});

describe("buildChallenge", () => {
  it("emits Coinbase-flavour v2 shape (resource top-level, amount per-accept)", () => {
    const body = buildChallenge(BASE_OPTS, "https://api.example/paid");
    expect(body.x402Version).toBe(2);
    // resource is now top-level structured (not a per-accept string).
    expect(body.resource.url).toBe("https://api.example/paid");
    expect(body.resource.description).toBe("test");
    expect(body.resource.mimeType).toBe("application/json");
    // accepts uses v2 field names: `amount` (not `maxAmountRequired`),
    // `maxTimeoutSeconds` (required positive number per @x402/core spec).
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0]!.amount).toBe(
      BASE_OPTS.acceptedPayments[0]!.maxAmountRequired,
    );
    expect(body.accepts[0]!.maxTimeoutSeconds).toBeGreaterThan(0);
    expect(body.accepts[0]!.payTo).toBe(BASE_OPTS.acceptedPayments[0]!.payTo);
  });
  it("forwards an error hint when supplied", () => {
    const body = buildChallenge(BASE_OPTS, "https://x", "bad_sig");
    expect(body.error).toBe("bad_sig");
  });
  it("honours an explicit x402Version=1", () => {
    const body = buildChallenge(
      { ...BASE_OPTS, x402Version: 1 },
      "https://x",
    );
    expect(body.x402Version).toBe(1);
  });
  it("forwards per-accept `extra` (e.g. EIP-712 domain) when configured", () => {
    const body = buildChallenge(
      {
        ...BASE_OPTS,
        acceptedPayments: [
          {
            ...BASE_OPTS.acceptedPayments[0]!,
            extra: { name: "USD Coin", version: "2" },
          },
        ],
      },
      "https://x",
    );
    expect(body.accepts[0]!.extra).toEqual({ name: "USD Coin", version: "2" });
  });
});

describe("buildChallenge — ecosystem compatibility", () => {
  it("matches the @x402/core@2.14+ PaymentRequiredV2Schema field set", () => {
    const body = buildChallenge(BASE_OPTS, "https://api.example/paid");
    // Required by ResourceInfoSchema:
    expect(typeof body.resource.url).toBe("string");
    expect(body.resource.url.length).toBeGreaterThan(0);
    // Required by PaymentRequirementsV2Schema (per-accept):
    for (const a of body.accepts) {
      expect(typeof a.scheme).toBe("string");
      expect(typeof a.network).toBe("string");
      expect(typeof a.amount).toBe("string");
      expect(typeof a.asset).toBe("string");
      expect(typeof a.payTo).toBe("string");
      expect(typeof a.maxTimeoutSeconds).toBe("number");
      expect(a.maxTimeoutSeconds).toBeGreaterThan(0);
    }
  });
});

describe("decodePaymentHeader", () => {
  it("parses a well-formed base64 JSON header", () => {
    const decoded = decodePaymentHeader(
      encodeHeader({
        x402Version: 2,
        scheme: "exact",
        network: "eip155:8453",
        payload: { foo: 1 },
      }),
    );
    expect(decoded.x402Version).toBe(2);
    expect(decoded.scheme).toBe("exact");
    expect(decoded.network).toBe("eip155:8453");
  });
  it("rejects non-JSON", () => {
    expect(() => decodePaymentHeader("notbase64@@@")).toThrowError(X402Error);
  });
  it("rejects a payload missing scheme", () => {
    expect(() =>
      decodePaymentHeader(
        encodeHeader({ x402Version: 2, network: "eip155:8453", payload: {} }),
      ),
    ).toThrowError(X402Error);
  });
  it("rejects an array at the top level", () => {
    expect(() =>
      decodePaymentHeader(Buffer.from("[]", "utf8").toString("base64")),
    ).toThrowError(X402Error);
  });
  it("accepts the v2-nested shape (`accepted.scheme`/`accepted.network`)", () => {
    // What `@x402/fetch` v2.14+ sends on the PAYMENT-SIGNATURE header:
    // scheme/network are nested inside `accepted`, not at the top level.
    const decoded = decodePaymentHeader(
      encodeHeader({
        x402Version: 2,
        accepted: {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0",
          amount: "70000",
          maxTimeoutSeconds: 60,
        },
        payload: { authorization: { from: "0xabc" }, signature: "0xdead" },
      }),
    );
    expect(decoded.scheme).toBe("exact");
    expect(decoded.network).toBe("eip155:8453");
  });
});

describe("matchRequirement", () => {
  it("finds a matching scheme+network", () => {
    const decoded = decodePaymentHeader(
      encodeHeader({
        x402Version: 2,
        scheme: "exact",
        network: "eip155:8453",
        payload: {},
      }),
    );
    const match = matchRequirement(decoded, BASE_OPTS.acceptedPayments);
    expect(match).toBeDefined();
    expect(match!.network).toBe("eip155:8453");
  });
  it("returns undefined when no match", () => {
    const decoded = decodePaymentHeader(
      encodeHeader({
        x402Version: 2,
        scheme: "exact",
        network: "solana:mainnet",
        payload: {},
      }),
    );
    expect(matchRequirement(decoded, BASE_OPTS.acceptedPayments)).toBeUndefined();
  });
});

describe("runProtocol", () => {
  it("returns challenge when no X-Payment", async () => {
    const result = await runProtocol({
      opts: BASE_OPTS,
      resourceUrl: "https://api.example/paid",
      paymentHeader: undefined,
      idempotencyKey: undefined,
    });
    expect(result.kind).toBe("challenge");
    if (result.kind === "challenge") {
      expect(result.status).toBe(402);
    }
  });

  it("rejects when X-Payment is malformed", async () => {
    const result = await runProtocol({
      opts: BASE_OPTS,
      resourceUrl: "https://api.example/paid",
      paymentHeader: "not-base64!!!",
      idempotencyKey: undefined,
    });
    expect(result.kind).toBe("rejected");
  });

  it("rejects when no requirement matches", async () => {
    const header = encodeHeader({
      x402Version: 2,
      scheme: "exact",
      network: "solana:mainnet",
      payload: {},
    });
    const result = await runProtocol({
      opts: BASE_OPTS,
      resourceUrl: "https://api.example/paid",
      paymentHeader: header,
      idempotencyKey: undefined,
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toBe("no_matching_requirement");
    }
  });

  it("accepts on verify+settle success", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ isValid: true, payer: "0xabc" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: true, transaction: "0xtx", payer: "0xabc" }),
          { status: 200 },
        ),
      );
    const result = await runProtocol({
      opts: { ...BASE_OPTS, fetchImpl },
      resourceUrl: "https://api.example/paid",
      paymentHeader: encodeHeader({
        x402Version: 2,
        scheme: "exact",
        network: "eip155:8453",
        payload: { sig: "deadbeef" },
      }),
      idempotencyKey: "fixed-key",
    });
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") {
      expect(result.receipt.txHash).toBe("0xtx");
      expect(result.receipt.payer).toBe("0xabc");
      expect(result.receipt.network).toBe("eip155:8453");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [verifyUrl] = fetchImpl.mock.calls[0]!;
    const [settleUrl, settleInit] = fetchImpl.mock.calls[1]!;
    expect(verifyUrl).toBe("https://facilitator.example.com/facilitator/verify");
    expect(settleUrl).toBe("https://facilitator.example.com/facilitator/settle");
    expect(
      (settleInit as RequestInit).headers as Record<string, string>,
    ).toMatchObject({
      Authorization: `Bearer ${BASE_OPTS.apiKey}`,
      "Idempotency-Key": "fixed-key",
    });
  });

  it("verify-only mode skips settle and returns null txHash", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ isValid: true, payer: "0xabc" }), {
          status: 200,
        }),
      );
    const result = await runProtocol({
      opts: { ...BASE_OPTS, fetchImpl, settle: false },
      resourceUrl: "https://api.example/paid",
      paymentHeader: encodeHeader({
        x402Version: 2,
        scheme: "exact",
        network: "eip155:8453",
        payload: { sig: "x" },
      }),
      idempotencyKey: undefined,
    });
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") {
      expect(result.receipt.txHash).toBeNull();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects when verify returns isValid: false", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ isValid: false, invalidReason: "bad_signature" }),
        { status: 200 },
      ),
    );
    const result = await runProtocol({
      opts: { ...BASE_OPTS, fetchImpl },
      resourceUrl: "https://api.example/paid",
      paymentHeader: encodeHeader({
        x402Version: 2,
        scheme: "exact",
        network: "eip155:8453",
        payload: {},
      }),
      idempotencyKey: undefined,
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toBe("bad_signature");
    }
  });

  it("rejects when facilitator returns 5xx", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ errorMessage: "down" }), { status: 503 }),
      );
    const result = await runProtocol({
      opts: { ...BASE_OPTS, fetchImpl },
      resourceUrl: "https://api.example/paid",
      paymentHeader: encodeHeader({
        x402Version: 2,
        scheme: "exact",
        network: "eip155:8453",
        payload: {},
      }),
      idempotencyKey: undefined,
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.status).toBe(502);
    }
  });

  it("normalises a trailing slash on the facilitator URL", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ isValid: true, payer: "0x1" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, transaction: "0x2" }), {
          status: 200,
        }),
      );
    await runProtocol({
      opts: {
        ...BASE_OPTS,
        facilitator: "https://facilitator.example.com///",
        fetchImpl,
      },
      resourceUrl: "https://api.example/paid",
      paymentHeader: encodeHeader({
        x402Version: 2,
        scheme: "exact",
        network: "eip155:8453",
        payload: {},
      }),
      idempotencyKey: undefined,
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      "https://facilitator.example.com/facilitator/verify",
    );
  });
});
