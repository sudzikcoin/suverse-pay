import { describe, expect, it } from "vitest";
import {
  StripeMppAdapter,
  TEMPO_MAINNET_CAIP2,
  TEMPO_MAINNET_USDC,
  TEMPO_MODERATO_CAIP2,
  type MppCapability,
  type MppChallenge,
  type MppCredential,
} from "./index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SAMPLE_CHALLENGE: MppChallenge = {
  id: "chal_abc",
  realm: "api.example.com",
  method: "tempo",
  intent: "charge",
  request: { amount: "1000000", currency: "USDC", recipient: "0xRecipient..." },
};
const SAMPLE_CREDENTIAL: MppCredential = {
  challengeId: "chal_abc",
  method: "tempo",
  intent: "charge",
  payload: { type: "transaction", signature: "0x" + "ab".repeat(65) },
};

describe("StripeMppAdapter constants", () => {
  it("Tempo mainnet uses EIP-155 chainId 4217", () => {
    expect(TEMPO_MAINNET_CAIP2).toBe("eip155:4217");
  });
  it("Tempo Moderato testnet uses EIP-155 chainId 42431", () => {
    expect(TEMPO_MODERATO_CAIP2).toBe("eip155:42431");
  });
  it("Tempo mainnet USDC address has the canonical checksum case", () => {
    expect(TEMPO_MAINNET_USDC).toBe(
      "0x20C000000000000000000000b9537d11c60E8b50",
    );
  });
});

describe("StripeMppAdapter basics", () => {
  it("exposes id + default display name", () => {
    const a = new StripeMppAdapter();
    expect(a.id).toBe("mpp-stripe");
    expect(a.displayName).toBe("Stripe Machine Payments Protocol");
  });

  it("getCapabilities returns Tempo (mainnet + Moderato) + Stripe SPT entries by default", () => {
    const a = new StripeMppAdapter();
    const caps = a.getCapabilities();
    expect(caps.length).toBeGreaterThanOrEqual(3);
    const tempoMainCharge = caps.find(
      (c) => c.method === "tempo" && c.intent === "charge" && c.network === TEMPO_MAINNET_CAIP2,
    );
    expect(tempoMainCharge?.asset).toBe(TEMPO_MAINNET_USDC);
    const tempoModerato = caps.find(
      (c) => c.method === "tempo" && c.intent === "charge" && c.network === TEMPO_MODERATO_CAIP2,
    );
    expect(tempoModerato).toBeDefined();
    const stripeSpt = caps.find(
      (c) => c.method === "stripe" && c.intent === "charge",
    );
    expect(stripeSpt).toBeDefined();
  });

  it("accepts a custom capability list", () => {
    const customCaps: MppCapability[] = [
      { method: "lightning", intent: "charge", asset: "BTC" },
    ];
    const a = new StripeMppAdapter({ capabilities: customCaps });
    expect(a.getCapabilities()).toEqual(customCaps);
  });
});

describe("StripeMppAdapter credential gating", () => {
  it("verifyCredential throws unauthorized without a secret key", async () => {
    const a = new StripeMppAdapter();
    await expect(
      a.verifyCredential({
        challenge: SAMPLE_CHALLENGE,
        credential: SAMPLE_CREDENTIAL,
      }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "unauthorized",
      providerId: "mpp-stripe",
    });
  });

  it("settleCredential throws unauthorized without a secret key", async () => {
    const a = new StripeMppAdapter();
    await expect(
      a.settleCredential({
        challenge: SAMPLE_CHALLENGE,
        credential: SAMPLE_CREDENTIAL,
      }),
    ).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
});

describe("StripeMppAdapter verifyCredential / settleCredential (with secret)", () => {
  // Stripe has not published REST paths for MPP verify/settle yet
  // (as of 2026-05-29). The adapter returns a structured
  // "endpoint-not-wired" result that surfaces a clear error code +
  // message rather than silently passing. These tests pin that
  // behavior — when REST paths are published, the implementation
  // changes here and these tests update.
  it("verifyCredential returns valid=false + unsupported_scheme until REST path is wired", async () => {
    const a = new StripeMppAdapter({ secretKey: "sk_test_dummy" });
    const r = await a.verifyCredential({
      challenge: SAMPLE_CHALLENGE,
      credential: SAMPLE_CREDENTIAL,
    });
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("unsupported_scheme");
    expect(r.errorMessage).toContain("not yet publicly documented");
  });

  it("settleCredential returns settled=false until REST path is wired", async () => {
    const a = new StripeMppAdapter({ secretKey: "sk_test_dummy" });
    const r = await a.settleCredential({
      challenge: SAMPLE_CHALLENGE,
      credential: SAMPLE_CREDENTIAL,
    });
    expect(r.settled).toBe(false);
    expect(r.errorCode).toBe("unsupported_scheme");
  });
});

describe("StripeMppAdapter getHealthStatus", () => {
  it("returns healthy on 2xx from api.stripe.com/v1", async () => {
    const a = new StripeMppAdapter({
      fetchImpl: async () => jsonResponse({ ok: true }, 200),
    });
    const h = await a.getHealthStatus();
    expect(h.status).toBe("healthy");
  });

  it("treats 4xx as healthy (host is reachable; auth would fail but that's not a liveness concern)", async () => {
    const a = new StripeMppAdapter({
      fetchImpl: async () => jsonResponse({ error: "auth" }, 401),
    });
    const h = await a.getHealthStatus();
    expect(h.status).toBe("healthy");
  });

  it("returns down on 5xx", async () => {
    const a = new StripeMppAdapter({
      fetchImpl: async () => jsonResponse({ error: "internal" }, 502),
    });
    const h = await a.getHealthStatus();
    expect(h.status).toBe("down");
    expect(h.error).toContain("502");
  });

  it("returns down on network error", async () => {
    const a = new StripeMppAdapter({
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const h = await a.getHealthStatus();
    expect(h.status).toBe("down");
  });
});
