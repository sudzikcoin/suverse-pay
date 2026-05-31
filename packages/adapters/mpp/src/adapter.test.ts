import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEMPO_MODERATO_RPC_URL,
  MppAdapter,
  TEMPO_MAINNET_CAIP2,
  TEMPO_MAINNET_USDC,
  TEMPO_MODERATO_CAIP2,
  TEMPO_MODERATO_PATHUSD,
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

describe("MppAdapter constants", () => {
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
  // Phase 2 T5 — Moderato test stablecoin published at
  // docs.tempo.xyz/quickstart/faucet. v1 default is pathUSD only.
  it("Tempo Moderato pathUSD address pins the documented faucet slot", () => {
    expect(TEMPO_MODERATO_PATHUSD).toBe(
      "0x20c0000000000000000000000000000000000000",
    );
  });
  it("DEFAULT_TEMPO_MODERATO_RPC_URL matches Tempo's published endpoint", () => {
    expect(DEFAULT_TEMPO_MODERATO_RPC_URL).toBe(
      "https://rpc.moderato.tempo.xyz",
    );
  });
});

describe("MppAdapter basics", () => {
  it("exposes id + default display name", () => {
    const a = new MppAdapter();
    expect(a.id).toBe("mpp");
    expect(a.displayName).toBe("Machine Payments Protocol");
  });

  it("getCapabilities returns Tempo mainnet (USDC) + Moderato (pathUSD); no stripe in v1", () => {
    const a = new MppAdapter();
    const caps = a.getCapabilities();
    expect(caps).toHaveLength(2);
    const tempoMainCharge = caps.find(
      (c) => c.method === "tempo" && c.intent === "charge" && c.network === TEMPO_MAINNET_CAIP2,
    );
    expect(tempoMainCharge?.asset).toBe(TEMPO_MAINNET_USDC);
    const tempoModerato = caps.find(
      (c) => c.method === "tempo" && c.intent === "charge" && c.network === TEMPO_MODERATO_CAIP2,
    );
    expect(tempoModerato).toBeDefined();
    // Phase 2 T5 — Moderato advertises pathUSD as the v1 default
    // asset. AlphaUSD/BetaUSD/ThetaUSD remain available on the faucet
    // but are not advertised here to keep the surface minimal.
    expect(tempoModerato?.asset).toBe(TEMPO_MODERATO_PATHUSD);
    // Phase 2 T3: stripe method dropped from v1 default capabilities —
    // Stripe has not published the MPP REST surface, so advertising
    // stripe+charge would route into the endpoint-not-wired error path.
    // Restore when Stripe opens the API.
    const stripeSpt = caps.find(
      (c) => c.method === "stripe" && c.intent === "charge",
    );
    expect(stripeSpt).toBeUndefined();
  });

  it("getTempoModeratoRpcUrl falls back to the public Tempo default", () => {
    const a = new MppAdapter();
    expect(a.getTempoModeratoRpcUrl()).toBe(DEFAULT_TEMPO_MODERATO_RPC_URL);
  });

  it("getTempoModeratoRpcUrl honors an operator override (private RPC mirror)", () => {
    const a = new MppAdapter({
      tempoModeratoRpcUrl: "https://rpc.internal.example/tempo-moderato",
    });
    expect(a.getTempoModeratoRpcUrl()).toBe(
      "https://rpc.internal.example/tempo-moderato",
    );
  });

  it("getTempoModeratoRpcUrl strips a trailing slash from the configured URL", () => {
    const a = new MppAdapter({
      tempoModeratoRpcUrl: "https://rpc.moderato.tempo.xyz/",
    });
    expect(a.getTempoModeratoRpcUrl()).toBe(
      "https://rpc.moderato.tempo.xyz",
    );
  });

  it("accepts a custom capability list", () => {
    const customCaps: MppCapability[] = [
      { method: "lightning", intent: "charge", asset: "BTC" },
    ];
    const a = new MppAdapter({ capabilities: customCaps });
    expect(a.getCapabilities()).toEqual(customCaps);
  });
});

describe("MppAdapter credential gating", () => {
  it("verifyCredential throws unauthorized without a secret key", async () => {
    const a = new MppAdapter();
    await expect(
      a.verifyCredential({
        challenge: SAMPLE_CHALLENGE,
        credential: SAMPLE_CREDENTIAL,
      }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "unauthorized",
      providerId: "mpp",
    });
  });

  it("settleCredential throws unauthorized without a secret key", async () => {
    const a = new MppAdapter();
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

describe("MppAdapter verifyCredential / settleCredential (with secret)", () => {
  // Stripe has not published REST paths for MPP verify/settle yet
  // (as of 2026-05-29). The adapter returns a structured
  // "endpoint-not-wired" result that surfaces a clear error code +
  // message rather than silently passing. These tests pin that
  // behavior — when REST paths are published, the implementation
  // changes here and these tests update.
  it("verifyCredential returns valid=false + unsupported_scheme until REST path is wired", async () => {
    const a = new MppAdapter({ secretKey: "sk_test_dummy" });
    const r = await a.verifyCredential({
      challenge: SAMPLE_CHALLENGE,
      credential: SAMPLE_CREDENTIAL,
    });
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("unsupported_scheme");
    expect(r.errorMessage).toContain("not yet publicly documented");
  });

  it("settleCredential returns settled=false until REST path is wired", async () => {
    const a = new MppAdapter({ secretKey: "sk_test_dummy" });
    const r = await a.settleCredential({
      challenge: SAMPLE_CHALLENGE,
      credential: SAMPLE_CREDENTIAL,
    });
    expect(r.settled).toBe(false);
    expect(r.errorCode).toBe("unsupported_scheme");
  });
});

describe("MppAdapter intent guard (Phase 2 T4 — v1 charge-only)", () => {
  // v1 only handles intent="charge". The MPP spec's "subscription"
  // and "session" intents require Stripe REST endpoints that aren't
  // public, so the adapter rejects them at the dispatch boundary —
  // before any secret-key check — with a structured result (no throw).
  const subscriptionCred: MppCredential = {
    ...SAMPLE_CREDENTIAL,
    intent: "subscription",
  };
  const sessionCred: MppCredential = {
    ...SAMPLE_CREDENTIAL,
    intent: "session",
  };

  it("verifyCredential rejects intent=subscription with unsupported_intent (no secret needed)", async () => {
    const a = new MppAdapter(); // no secretKey
    const r = await a.verifyCredential({
      challenge: SAMPLE_CHALLENGE,
      credential: subscriptionCred,
    });
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("unsupported_intent");
    expect(r.errorMessage).toContain("charge");
    expect(r.errorMessage).toContain("subscription");
  });

  it("verifyCredential rejects intent=session with unsupported_intent (no secret needed)", async () => {
    const a = new MppAdapter();
    const r = await a.verifyCredential({
      challenge: SAMPLE_CHALLENGE,
      credential: sessionCred,
    });
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("unsupported_intent");
    expect(r.errorMessage).toContain("session");
  });

  it("settleCredential rejects intent=subscription with unsupported_intent (no secret needed)", async () => {
    const a = new MppAdapter();
    const r = await a.settleCredential({
      challenge: SAMPLE_CHALLENGE,
      credential: subscriptionCred,
    });
    expect(r.settled).toBe(false);
    expect(r.errorCode).toBe("unsupported_intent");
  });

  it("settleCredential rejects intent=session with unsupported_intent (no secret needed)", async () => {
    const a = new MppAdapter();
    const r = await a.settleCredential({
      challenge: SAMPLE_CHALLENGE,
      credential: sessionCred,
    });
    expect(r.settled).toBe(false);
    expect(r.errorCode).toBe("unsupported_intent");
  });

  it("intent guard runs BEFORE the secret-key check (subscription returns structured, not throw)", async () => {
    // Without the guard, this would throw ProviderError("unauthorized")
    // because no secretKey is configured. With the guard, the result
    // is structured.
    const a = new MppAdapter();
    await expect(
      a.verifyCredential({
        challenge: SAMPLE_CHALLENGE,
        credential: subscriptionCred,
      }),
    ).resolves.toMatchObject({ errorCode: "unsupported_intent" });
  });
});

describe("MppAdapter getHealthStatus", () => {
  it("returns healthy on 2xx from api.stripe.com/v1", async () => {
    const a = new MppAdapter({
      fetchImpl: async () => jsonResponse({ ok: true }, 200),
    });
    const h = await a.getHealthStatus();
    expect(h.status).toBe("healthy");
  });

  it("treats 4xx as healthy (host is reachable; auth would fail but that's not a liveness concern)", async () => {
    const a = new MppAdapter({
      fetchImpl: async () => jsonResponse({ error: "auth" }, 401),
    });
    const h = await a.getHealthStatus();
    expect(h.status).toBe("healthy");
  });

  it("returns down on 5xx", async () => {
    const a = new MppAdapter({
      fetchImpl: async () => jsonResponse({ error: "internal" }, 502),
    });
    const h = await a.getHealthStatus();
    expect(h.status).toBe("down");
    expect(h.error).toContain("502");
  });

  it("returns down on network error", async () => {
    const a = new MppAdapter({
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const h = await a.getHealthStatus();
    expect(h.status).toBe("down");
  });
});
