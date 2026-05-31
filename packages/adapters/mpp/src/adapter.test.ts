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

describe("MppAdapter Tempo Moderato direct-RPC (Phase 2 T6 — type=hash only)", () => {
  // The Moderato path bypasses Stripe entirely. Client broadcasts the
  // transfer onto Tempo Moderato testnet (chainId 42431), then sends
  // an MPP credential with `payload: { type: "hash", hash: "0x..." }`.
  // The adapter pulls the receipt via direct JSON-RPC and validates
  // the Transfer log against the challenge. Mirrors wevm/mppx's
  // canonical `case 'hash'` flow.

  const PAYER = "0x1111111111111111111111111111111111111111";
  const RECIPIENT = "0x2222222222222222222222222222222222222222";
  const TX_HASH =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  // Challenge that targets Tempo Moderato testnet. `chainId: 42431`
  // is what triggers the direct-RPC dispatch route.
  const MODERATO_CHALLENGE: MppChallenge = {
    id: "chal_moderato_1",
    realm: "api.example.com",
    method: "tempo",
    intent: "charge",
    request: {
      amount: "1000000", // 1.000000 pathUSD at 6 decimals
      currency: TEMPO_MODERATO_PATHUSD,
      recipient: RECIPIENT,
      chainId: 42431,
    },
  };

  // Credential with payload.type="hash".
  const MODERATO_HASH_CRED: MppCredential = {
    challengeId: "chal_moderato_1",
    method: "tempo",
    intent: "charge",
    payload: { type: "hash", hash: TX_HASH },
  };

  /**
   * Construct an EVM-style Transfer log. Topic 0 is the keccak256 of
   * "Transfer(address,address,uint256)"; topics 1+2 are zero-padded
   * lowercase 32-byte addresses; data is the 32-byte hex value.
   */
  function transferLog(args: {
    contract: string;
    from: string;
    to: string;
    amount: bigint;
  }) {
    const pad = (a: string) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
    const amountHex =
      "0x" + args.amount.toString(16).padStart(64, "0");
    return {
      address: args.contract.toLowerCase(),
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        pad(args.from),
        pad(args.to),
      ],
      data: amountHex,
    };
  }

  function rpcReceiptResponse(receipt: unknown): Response {
    return jsonResponse({ jsonrpc: "2.0", id: 1, result: receipt });
  }

  it("happy path — receipt with matching Transfer log returns valid + payer", async () => {
    const a = new MppAdapter({
      fetchImpl: async () =>
        rpcReceiptResponse({
          status: "0x1",
          from: PAYER,
          to: TEMPO_MODERATO_PATHUSD,
          logs: [
            transferLog({
              contract: TEMPO_MODERATO_PATHUSD,
              from: PAYER,
              to: RECIPIENT,
              amount: 1_000_000n,
            }),
          ],
        }),
    });
    const r = await a.verifyCredential({
      challenge: MODERATO_CHALLENGE,
      credential: MODERATO_HASH_CRED,
    });
    expect(r.valid).toBe(true);
    expect(r.errorCode).toBeUndefined();
    expect(r.payer?.toLowerCase()).toBe(PAYER.toLowerCase());
  });

  it("happy path — settleCredential mirrors verify + projects amount/asset/reference", async () => {
    const a = new MppAdapter({
      fetchImpl: async () =>
        rpcReceiptResponse({
          status: "0x1",
          from: PAYER,
          to: TEMPO_MODERATO_PATHUSD,
          logs: [
            transferLog({
              contract: TEMPO_MODERATO_PATHUSD,
              from: PAYER,
              to: RECIPIENT,
              amount: 1_000_000n,
            }),
          ],
        }),
    });
    const r = await a.settleCredential({
      challenge: MODERATO_CHALLENGE,
      credential: MODERATO_HASH_CRED,
    });
    expect(r.settled).toBe(true);
    expect(r.reference).toBe(TX_HASH);
    expect(r.amount).toBe("1000000");
    expect(r.asset).toBe(TEMPO_MODERATO_PATHUSD);
    expect(r.network).toBe(TEMPO_MODERATO_CAIP2);
    expect(r.errorCode).toBeUndefined();
  });

  it("accepts a Transfer with value strictly greater than the challenge amount (overpayment)", async () => {
    const a = new MppAdapter({
      fetchImpl: async () =>
        rpcReceiptResponse({
          status: "0x1",
          from: PAYER,
          to: TEMPO_MODERATO_PATHUSD,
          logs: [
            transferLog({
              contract: TEMPO_MODERATO_PATHUSD,
              from: PAYER,
              to: RECIPIENT,
              amount: 5_000_000n, // 5× the challenge
            }),
          ],
        }),
    });
    const r = await a.verifyCredential({
      challenge: MODERATO_CHALLENGE,
      credential: MODERATO_HASH_CRED,
    });
    expect(r.valid).toBe(true);
  });

  it("rejects when the transaction is not yet mined (RPC returns result=null)", async () => {
    const a = new MppAdapter({
      fetchImpl: async () => rpcReceiptResponse(null),
    });
    const r = await a.verifyCredential({
      challenge: MODERATO_CHALLENGE,
      credential: MODERATO_HASH_CRED,
    });
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("transaction_not_found");
    expect(r.errorMessage).toContain(TX_HASH);
  });

  it("rejects a reverted transaction (status=0x0)", async () => {
    const a = new MppAdapter({
      fetchImpl: async () =>
        rpcReceiptResponse({
          status: "0x0",
          from: PAYER,
          to: TEMPO_MODERATO_PATHUSD,
          logs: [],
        }),
    });
    const r = await a.verifyCredential({
      challenge: MODERATO_CHALLENGE,
      credential: MODERATO_HASH_CRED,
    });
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("transaction_reverted");
  });

  it("rejects a Transfer on a different ERC-20 contract", async () => {
    const a = new MppAdapter({
      fetchImpl: async () =>
        rpcReceiptResponse({
          status: "0x1",
          from: PAYER,
          to: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          logs: [
            transferLog({
              contract: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
              from: PAYER,
              to: RECIPIENT,
              amount: 1_000_000n,
            }),
          ],
        }),
    });
    const r = await a.verifyCredential({
      challenge: MODERATO_CHALLENGE,
      credential: MODERATO_HASH_CRED,
    });
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("transfer_not_found");
  });

  it("rejects a Transfer that pays a different recipient", async () => {
    const a = new MppAdapter({
      fetchImpl: async () =>
        rpcReceiptResponse({
          status: "0x1",
          from: PAYER,
          to: TEMPO_MODERATO_PATHUSD,
          logs: [
            transferLog({
              contract: TEMPO_MODERATO_PATHUSD,
              from: PAYER,
              to: "0x3333333333333333333333333333333333333333",
              amount: 1_000_000n,
            }),
          ],
        }),
    });
    const r = await a.verifyCredential({
      challenge: MODERATO_CHALLENGE,
      credential: MODERATO_HASH_CRED,
    });
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("transfer_not_found");
  });

  it("rejects an underpayment (value less than challenge amount)", async () => {
    const a = new MppAdapter({
      fetchImpl: async () =>
        rpcReceiptResponse({
          status: "0x1",
          from: PAYER,
          to: TEMPO_MODERATO_PATHUSD,
          logs: [
            transferLog({
              contract: TEMPO_MODERATO_PATHUSD,
              from: PAYER,
              to: RECIPIENT,
              amount: 999_999n, // 1 atomic unit short
            }),
          ],
        }),
    });
    const r = await a.verifyCredential({
      challenge: MODERATO_CHALLENGE,
      credential: MODERATO_HASH_CRED,
    });
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("transfer_not_found");
  });

  it("surfaces an RPC HTTP failure (5xx) as rpc_error", async () => {
    const a = new MppAdapter({
      fetchImpl: async () =>
        new Response("upstream gone", {
          status: 503,
          statusText: "Service Unavailable",
        }),
    });
    const r = await a.verifyCredential({
      challenge: MODERATO_CHALLENGE,
      credential: MODERATO_HASH_CRED,
    });
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("rpc_error");
    expect(r.errorMessage).toContain("503");
  });

  it("surfaces an RPC-level error response as rpc_error", async () => {
    const a = new MppAdapter({
      fetchImpl: async () =>
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32602, message: "Invalid params" },
        }),
    });
    const r = await a.verifyCredential({
      challenge: MODERATO_CHALLENGE,
      credential: MODERATO_HASH_CRED,
    });
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("rpc_error");
    expect(r.errorMessage).toContain("Invalid params");
  });

  it("rejects a malformed challenge missing amount/recipient/currency", async () => {
    const a = new MppAdapter({
      fetchImpl: async () =>
        rpcReceiptResponse({ status: "0x1", from: PAYER, to: null, logs: [] }),
    });
    const r = await a.verifyCredential({
      challenge: {
        ...MODERATO_CHALLENGE,
        request: { chainId: 42431 }, // amount/recipient/currency missing
      },
      credential: MODERATO_HASH_CRED,
    });
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("malformed_challenge");
  });

  it("rejects when challenge amount is not a decimal-integer string", async () => {
    const a = new MppAdapter({
      fetchImpl: async () =>
        rpcReceiptResponse({ status: "0x1", from: PAYER, to: null, logs: [] }),
    });
    const r = await a.verifyCredential({
      challenge: {
        ...MODERATO_CHALLENGE,
        request: { ...MODERATO_CHALLENGE.request, amount: "not-a-number" },
      },
      credential: MODERATO_HASH_CRED,
    });
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("malformed_challenge");
  });

  it("payload.type=\"transaction\" returns unsupported_payload_type (v1 hash-only)", async () => {
    const a = new MppAdapter();
    const cred: MppCredential = {
      ...MODERATO_HASH_CRED,
      payload: { type: "transaction", signature: "0x" + "ab".repeat(65) },
    };
    const r = await a.verifyCredential({
      challenge: MODERATO_CHALLENGE,
      credential: cred,
    });
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("unsupported_payload_type");
    expect(r.errorMessage).toContain("hash");
    expect(r.errorMessage).toContain("transaction");
  });

  it("payload.type=\"proof\" returns unsupported_payload_type", async () => {
    const a = new MppAdapter();
    const cred: MppCredential = {
      ...MODERATO_HASH_CRED,
      payload: { type: "proof", signature: "0x" + "cd".repeat(65) },
    };
    const r = await a.verifyCredential({
      challenge: MODERATO_CHALLENGE,
      credential: cred,
    });
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("unsupported_payload_type");
  });

  it("rejects a malformed payload hash (wrong length) as unsupported_payload_type", async () => {
    const a = new MppAdapter();
    const cred: MppCredential = {
      ...MODERATO_HASH_CRED,
      payload: { type: "hash", hash: "0xdeadbeef" }, // too short
    };
    const r = await a.verifyCredential({
      challenge: MODERATO_CHALLENGE,
      credential: cred,
    });
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("unsupported_payload_type");
  });

  it("chainId other than 42431 routes to the Stripe-facilitated path (unsupported_scheme requires secret)", async () => {
    // Tempo MAINNET (chainId=4217) — falls through to "endpoint not
    // wired" because the Stripe MPP REST surface isn't public yet.
    // Without a secretKey, the Stripe path throws unauthorized.
    const a = new MppAdapter();
    await expect(
      a.verifyCredential({
        challenge: {
          ...MODERATO_CHALLENGE,
          request: { ...MODERATO_CHALLENGE.request, chainId: 4217 },
        },
        credential: {
          ...MODERATO_HASH_CRED,
          payload: { type: "transaction", signature: "0x" + "ab".repeat(65) },
        },
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("settleCredential propagates verify errorCode on failure (no double-call surface)", async () => {
    const a = new MppAdapter({
      fetchImpl: async () => rpcReceiptResponse(null),
    });
    const r = await a.settleCredential({
      challenge: MODERATO_CHALLENGE,
      credential: MODERATO_HASH_CRED,
    });
    expect(r.settled).toBe(false);
    expect(r.errorCode).toBe("transaction_not_found");
    expect(r.reference).toBeUndefined();
  });

  it("respects an operator-overridden Tempo Moderato RPC URL", async () => {
    let calledUrl = "";
    const a = new MppAdapter({
      tempoModeratoRpcUrl: "https://rpc.internal.example/tempo-moderato",
      fetchImpl: async (input) => {
        calledUrl = typeof input === "string" ? input : (input as Request).url;
        return rpcReceiptResponse({
          status: "0x1",
          from: PAYER,
          to: TEMPO_MODERATO_PATHUSD,
          logs: [
            transferLog({
              contract: TEMPO_MODERATO_PATHUSD,
              from: PAYER,
              to: RECIPIENT,
              amount: 1_000_000n,
            }),
          ],
        });
      },
    });
    await a.verifyCredential({
      challenge: MODERATO_CHALLENGE,
      credential: MODERATO_HASH_CRED,
    });
    expect(calledUrl).toBe("https://rpc.internal.example/tempo-moderato");
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
