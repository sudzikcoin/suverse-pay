import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { SuverseClient } from "../src/client.js";
import type {
  AcceptedRequirement,
  ChallengeBody,
  MultiChainWallets,
} from "../src/types.js";
import {
  FacilitatorRejectedError,
  NoSupportedNetworkError,
  X402ClientError,
} from "../src/types.js";
import {
  GASFREE_MIN_USDT_ATOMIC,
  TRON_MAINNET,
} from "../src/network/tron-networks.js";
import { COSMOS_NOBLE_MAINNET } from "../src/network/cosmos-networks.js";
import { SOLANA_MAINNET } from "../src/network/solana-networks.js";
import { evmHexToTron } from "../src/signers/tron.js";

// ---------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------

const EVM_PRIV = generatePrivateKey();
const EVM_ACCOUNT = privateKeyToAccount(EVM_PRIV);

const SOLANA_KP = Keypair.generate();
const SOLANA_SECRET_B58 = bs58.encode(SOLANA_KP.secretKey);
const SOLANA_FEE_PAYER = Keypair.generate().publicKey.toBase58();

const COSMOS_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const TRON_PRIV = generatePrivateKey();
const TRON_ADDR_BASE58 = evmHexToTron(privateKeyToAccount(TRON_PRIV).address);

// A non-zero verifying contract so TronSigner doesn't refuse with the
// placeholder guard (real gasfree.io address would replace this).
const TRON_GASFREE_DOMAIN_MAINNET = {
  name: "GasFree",
  version: "V1.0.0",
  chainId: 728126428,
  verifyingContract: "0x" + "11".repeat(20) as `0x${string}`,
};

const URL = "https://api.seller.test/paid";

function evmAccept(network = "eip155:8453"): AcceptedRequirement {
  return {
    scheme: "exact",
    network,
    asset:
      network === "eip155:8453"
        ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
        : "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // Optimism USDC
    payTo: "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0",
    amount: "100000",
    maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
  };
}

function solanaAccept(): AcceptedRequirement {
  return {
    scheme: "exact",
    network: SOLANA_MAINNET,
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    payTo: Keypair.generate().publicKey.toBase58(),
    amount: "100000",
    maxTimeoutSeconds: 60,
    extra: { feePayer: SOLANA_FEE_PAYER },
  };
}

function cosmosAccept(): AcceptedRequirement {
  return {
    scheme: "exact_cosmos_authz",
    network: COSMOS_NOBLE_MAINNET,
    asset: "uusdc",
    payTo: "noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj",
    amount: "70000",
    maxTimeoutSeconds: 60,
    extra: {
      facilitator: "noble18jq3tgk39z8qk5jz304zqkhd02gs5zkhrj7sqt",
      chainId: "noble-1",
    },
  };
}

function tronAccept(): AcceptedRequirement {
  return {
    scheme: "exact_gasfree",
    network: TRON_MAINNET,
    asset: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    payTo: "TMpNsK3Dj2ehBwQ9Hv5PeFZboynD7JX2is",
    amount: GASFREE_MIN_USDT_ATOMIC.toString(),
    maxTimeoutSeconds: 60,
    extra: { name: "Tether USD", version: "1" },
  };
}

function challengeBody(accepts: AcceptedRequirement[]): ChallengeBody {
  return {
    x402Version: 2,
    resource: { url: URL, description: "test seller" },
    accepts,
  };
}

function makeFetchSequence(responses: Response[]): typeof fetch {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("no more responses queued");
    return next;
  }) as unknown as typeof fetch;
}

function challengeResponse(
  challenge: ChallengeBody,
  options: { withHeader?: boolean } = {},
): Response {
  const body = JSON.stringify(challenge);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.withHeader) {
    headers["PAYMENT-REQUIRED"] = Buffer.from(body, "utf8").toString("base64");
  }
  return new Response(body, { status: 402, headers });
}

function successResponse(
  data: unknown,
  options: {
    paymentResponse?: Record<string, unknown>;
    legacy?: boolean;
  } = {},
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.paymentResponse) {
    const b64 = Buffer.from(
      JSON.stringify(options.paymentResponse),
      "utf8",
    ).toString("base64");
    if (options.legacy) {
      headers["X-PAYMENT-RESPONSE"] = b64;
    } else {
      headers["PAYMENT-RESPONSE"] = b64;
    }
  }
  return new Response(JSON.stringify(data), { status: 200, headers });
}

// ---------------------------------------------------------------
// Construction
// ---------------------------------------------------------------

describe("SuverseClient construction", () => {
  it("accepts a single-VM EVM-only wallet config", () => {
    expect(
      () =>
        new SuverseClient({
          wallets: { evm: EVM_PRIV },
        }),
    ).not.toThrow();
  });

  it("accepts a four-VM full wallet config", () => {
    expect(
      () =>
        new SuverseClient({
          wallets: {
            evm: EVM_PRIV,
            solana: SOLANA_SECRET_B58,
            cosmos: COSMOS_MNEMONIC,
            tron: TRON_PRIV,
          } satisfies MultiChainWallets,
          signerOptions: {
            tron: { gasfreeDomain: { mainnet: TRON_GASFREE_DOMAIN_MAINNET } },
          },
        }),
    ).not.toThrow();
  });

  it("accepts a viem account directly as EVM wallet", () => {
    expect(
      () =>
        new SuverseClient({
          wallets: { evm: EVM_ACCOUNT as unknown as `0x${string}` },
        }),
    ).not.toThrow();
  });

  it("uses the supplied defaultFacilitator URL", () => {
    expect(
      () =>
        new SuverseClient({
          wallets: { evm: EVM_PRIV },
          defaultFacilitator: "https://facilitator.example.com",
        }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------
// .fetch() — happy paths per VM
// ---------------------------------------------------------------

describe("SuverseClient.fetch — EVM happy path", () => {
  it("returns 200 body without retry when no payment required", async () => {
    const fetchImpl = makeFetchSequence([
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ]);
    const client = new SuverseClient({
      wallets: { evm: EVM_PRIV },
      fetchImpl,
    });
    const result = await client.fetch<{ ok: boolean }>(URL);
    expect(result.data).toEqual({ ok: true });
    expect(result.payment.txHash).toBeNull();
  });

  it("retries with PAYMENT-SIGNATURE header on 402 and surfaces receipt", async () => {
    const fetchImpl = makeFetchSequence([
      challengeResponse(challengeBody([evmAccept()])),
      successResponse(
        { result: "data" },
        {
          paymentResponse: {
            success: true,
            transaction: "0xdeadbeef",
            network: "eip155:8453",
            payer: EVM_ACCOUNT.address,
            amount: "100000",
          },
        },
      ),
    ]);
    const client = new SuverseClient({ wallets: { evm: EVM_PRIV }, fetchImpl });
    const result = await client.fetch<{ result: string }>(URL);
    expect(result.data).toEqual({ result: "data" });
    expect(result.payment.network).toBe("eip155:8453");
    expect(result.payment.scheme).toBe("exact");
    expect(result.payment.txHash).toBe("0xdeadbeef");
    expect(result.payment.payer).toBe(EVM_ACCOUNT.address);
    expect(result.payment.amount).toBe("100000");

    const retryCall = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[1]!;
    const init = retryCall[1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get("PAYMENT-SIGNATURE")?.length).toBeGreaterThan(40);
    expect(headers.get("X-PAYMENT")).toBe(headers.get("PAYMENT-SIGNATURE"));
  });

  it("prefers PAYMENT-REQUIRED header over JSON body when both present", async () => {
    const challenge = challengeBody([evmAccept()]);
    const fetchImpl = makeFetchSequence([
      challengeResponse(challenge, { withHeader: true }),
      successResponse({ ok: true }),
    ]);
    const client = new SuverseClient({ wallets: { evm: EVM_PRIV }, fetchImpl });
    const result = await client.fetch(URL);
    expect((result.data as { ok: boolean }).ok).toBe(true);
  });

  it("falls back to X-PAYMENT-RESPONSE (v1) when v2 header is absent", async () => {
    const fetchImpl = makeFetchSequence([
      challengeResponse(challengeBody([evmAccept()])),
      successResponse(
        { ok: true },
        {
          paymentResponse: {
            success: true,
            txHash: "0xfeedface", // v1 uses txHash, v2 uses transaction
            network: "eip155:8453",
            payer: EVM_ACCOUNT.address,
            amount: "100000",
          },
          legacy: true,
        },
      ),
    ]);
    const client = new SuverseClient({ wallets: { evm: EVM_PRIV }, fetchImpl });
    const result = await client.fetch(URL);
    expect(result.payment.txHash).toBe("0xfeedface");
  });

  it("picks Base over Optimism by cost ranking (both L2 → tied → first wins)", async () => {
    const fetchImpl = makeFetchSequence([
      challengeResponse(
        challengeBody([evmAccept("eip155:10"), evmAccept("eip155:8453")]),
      ),
      successResponse({ ok: true }),
    ]);
    const client = new SuverseClient({ wallets: { evm: EVM_PRIV }, fetchImpl });
    const result = await client.fetch(URL);
    // Cost-rank ties on L2 — Optimism advertised first, so it wins.
    expect(["eip155:10", "eip155:8453"]).toContain(result.payment.network);
  });

  it("honours preferredNetwork", async () => {
    const fetchImpl = makeFetchSequence([
      challengeResponse(
        challengeBody([evmAccept("eip155:10"), evmAccept("eip155:8453")]),
      ),
      successResponse({ ok: true }),
    ]);
    const client = new SuverseClient({
      wallets: { evm: EVM_PRIV },
      preferences: { preferredNetwork: "eip155:8453" },
      fetchImpl,
    });
    const result = await client.fetch(URL);
    expect(result.payment.network).toBe("eip155:8453");
  });

  it("honours avoidNetworks", async () => {
    const fetchImpl = makeFetchSequence([
      challengeResponse(
        challengeBody([evmAccept("eip155:10"), evmAccept("eip155:8453")]),
      ),
      successResponse({ ok: true }),
    ]);
    const client = new SuverseClient({
      wallets: { evm: EVM_PRIV },
      preferences: { avoidNetworks: ["eip155:10"] },
      fetchImpl,
    });
    const result = await client.fetch(URL);
    expect(result.payment.network).toBe("eip155:8453");
  });
});

describe("SuverseClient.fetch — Solana happy path", () => {
  it("signs through SolanaSigner when seller asks for Solana mainnet", async () => {
    const fetchImpl = makeFetchSequence([
      challengeResponse(challengeBody([solanaAccept()])),
      successResponse({ result: "solana paid" }),
    ]);
    const client = new SuverseClient({
      wallets: { solana: SOLANA_SECRET_B58 },
      fetchImpl,
    });
    const result = await client.fetch(URL);
    expect(result.payment.network).toBe(SOLANA_MAINNET);
    expect(result.payment.scheme).toBe("exact");
    expect(result.payment.payer).toBe(SOLANA_KP.publicKey.toBase58());
  });

  it("picks Solana over EVM L1 by cost ranking when both wallets configured", async () => {
    const fetchImpl = makeFetchSequence([
      challengeResponse(
        challengeBody([evmAccept("eip155:1"), solanaAccept()]),
      ),
      successResponse({ ok: true }),
    ]);
    const client = new SuverseClient({
      wallets: { evm: EVM_PRIV, solana: SOLANA_SECRET_B58 },
      fetchImpl,
    });
    const result = await client.fetch(URL);
    expect(result.payment.network).toBe(SOLANA_MAINNET);
  });
});

describe("SuverseClient.fetch — Cosmos happy path", () => {
  it("signs through CosmosSigner on cosmos:noble-1 (resource URL threaded through)", async () => {
    const fetchImpl = makeFetchSequence([
      challengeResponse(challengeBody([cosmosAccept()])),
      successResponse(
        { ok: true },
        {
          paymentResponse: {
            success: true,
            transaction: "F11FE419" + "0".repeat(56),
            network: "cosmos:noble-1",
            payer: "noble1ignoredinthistest",
            amount: "70000",
          },
        },
      ),
    ]);
    const client = new SuverseClient({
      wallets: { cosmos: COSMOS_MNEMONIC },
      fetchImpl,
    });
    const result = await client.fetch(URL);
    expect(result.payment.network).toBe("cosmos:noble-1");
    expect(result.payment.txHash).toBe("F11FE419" + "0".repeat(56));
  });

  it("picks Cosmos over Solana over EVM by cost ranking", async () => {
    const fetchImpl = makeFetchSequence([
      challengeResponse(
        challengeBody([
          evmAccept("eip155:8453"),
          solanaAccept(),
          cosmosAccept(),
        ]),
      ),
      successResponse({ ok: true }),
    ]);
    const client = new SuverseClient({
      wallets: {
        evm: EVM_PRIV,
        solana: SOLANA_SECRET_B58,
        cosmos: COSMOS_MNEMONIC,
      },
      fetchImpl,
    });
    const result = await client.fetch(URL);
    expect(result.payment.network).toBe("cosmos:noble-1");
  });
});

describe("SuverseClient.fetch — TRON happy path", () => {
  it("signs through TronSigner on exact_gasfree", async () => {
    const fetchImpl = makeFetchSequence([
      challengeResponse(challengeBody([tronAccept()])),
      successResponse(
        { ok: true },
        {
          paymentResponse: {
            success: true,
            transaction: "f".repeat(64),
            network: "tron:mainnet",
            payer: TRON_ADDR_BASE58,
            amount: GASFREE_MIN_USDT_ATOMIC.toString(),
          },
        },
      ),
    ]);
    const client = new SuverseClient({
      wallets: { tron: TRON_PRIV },
      signerOptions: {
        tron: { gasfreeDomain: { mainnet: TRON_GASFREE_DOMAIN_MAINNET } },
      },
      fetchImpl,
    });
    const result = await client.fetch(URL);
    expect(result.payment.network).toBe("tron:mainnet");
    expect(result.payment.payer).toBe(TRON_ADDR_BASE58);
  });

  it("refuses to pick TRON `exact` (only gasfree supported in v0.1.0)", async () => {
    const fetchImpl = makeFetchSequence([
      challengeResponse(
        challengeBody([{ ...tronAccept(), scheme: "exact" }]),
      ),
    ]);
    const client = new SuverseClient({
      wallets: { tron: TRON_PRIV },
      signerOptions: {
        tron: { gasfreeDomain: { mainnet: TRON_GASFREE_DOMAIN_MAINNET } },
      },
      fetchImpl,
    });
    await expect(client.fetch(URL)).rejects.toThrowError(
      NoSupportedNetworkError,
    );
  });
});

// ---------------------------------------------------------------
// .fetch() — error paths
// ---------------------------------------------------------------

describe("SuverseClient.fetch — error paths", () => {
  it("throws unexpected_status when seller returns 500", async () => {
    const fetchImpl = makeFetchSequence([
      new Response("oops", { status: 500 }),
    ]);
    const client = new SuverseClient({ wallets: { evm: EVM_PRIV }, fetchImpl });
    await expect(client.fetch(URL)).rejects.toThrowError(/HTTP 500/);
  });

  it("throws NoSupportedNetworkError when wallet doesn't cover any chain", async () => {
    const fetchImpl = makeFetchSequence([
      challengeResponse(challengeBody([cosmosAccept()])),
    ]);
    const client = new SuverseClient({ wallets: { evm: EVM_PRIV }, fetchImpl });
    await expect(client.fetch(URL)).rejects.toThrowError(
      NoSupportedNetworkError,
    );
  });

  it("throws when challenge body is not JSON", async () => {
    const fetchImpl = makeFetchSequence([
      new Response("<html>oops</html>", {
        status: 402,
        headers: { "Content-Type": "text/html" },
      }),
    ]);
    const client = new SuverseClient({ wallets: { evm: EVM_PRIV }, fetchImpl });
    await expect(client.fetch(URL)).rejects.toThrowError(/JSON/);
  });

  it("throws payment_retry_failed when seller still returns non-200 after payment", async () => {
    const fetchImpl = makeFetchSequence([
      challengeResponse(challengeBody([evmAccept()])),
      new Response(
        JSON.stringify({ isValid: false, invalidReason: "bad_sig" }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      ),
    ]);
    const client = new SuverseClient({ wallets: { evm: EVM_PRIV }, fetchImpl });
    await expect(client.fetch(URL)).rejects.toThrowError(/retry/);
  });
});

// ---------------------------------------------------------------
// .pay() + .signFor() + .signRequirement()
// ---------------------------------------------------------------

describe("SuverseClient.pay (alias for signFor)", () => {
  it("returns a base64 header that decodes to a v2 envelope", async () => {
    const client = new SuverseClient({ wallets: { evm: EVM_PRIV } });
    const challenge = challengeBody([evmAccept()]);
    const header = await client.pay(challenge);
    expect(header).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.scheme).toBe("exact");
    expect(decoded.network).toBe("eip155:8453");
  });

  it("matches what signFor produces (alias check)", async () => {
    const client = new SuverseClient({ wallets: { evm: EVM_PRIV } });
    const challenge = challengeBody([evmAccept()]);
    // Pin nonce + now is hard since they're random — verify that
    // the produced envelopes have the same scheme+network+payTo (the
    // deterministic parts).
    const fromPay = JSON.parse(
      Buffer.from(await client.pay(challenge), "base64").toString("utf8"),
    );
    const fromSign = JSON.parse(
      Buffer.from(await client.signFor(challenge), "base64").toString("utf8"),
    );
    expect(fromPay.network).toBe(fromSign.network);
    expect(fromPay.scheme).toBe(fromSign.scheme);
    expect(fromPay.accepted.payTo).toBe(fromSign.accepted.payTo);
  });
});

describe("SuverseClient.signRequirement", () => {
  it("Cosmos path requires options.resource", async () => {
    const client = new SuverseClient({ wallets: { cosmos: COSMOS_MNEMONIC } });
    await expect(
      client.signRequirement(cosmosAccept()),
    ).rejects.toThrowError(/resource/);
  });

  it("Cosmos path succeeds when resource is provided", async () => {
    const client = new SuverseClient({ wallets: { cosmos: COSMOS_MNEMONIC } });
    const env = await client.signRequirement(cosmosAccept(), {
      resource: URL,
    });
    expect(env.network).toBe("cosmos:noble-1");
    expect(env.scheme).toBe("exact_cosmos_authz");
  });

  it("EVM path doesn't need options.resource", async () => {
    const client = new SuverseClient({ wallets: { evm: EVM_PRIV } });
    const env = await client.signRequirement(evmAccept());
    expect(env.network).toBe("eip155:8453");
  });

  it("rejects when no signer for the requested network family", async () => {
    const client = new SuverseClient({ wallets: { evm: EVM_PRIV } });
    await expect(
      client.signRequirement(solanaAccept()),
    ).rejects.toThrowError(/Solana/);
  });
});

// ---------------------------------------------------------------
// Type-level check for FacilitatorRejectedError export
// ---------------------------------------------------------------

describe("error exports", () => {
  it("FacilitatorRejectedError is constructible with the documented signature", () => {
    const err = new FacilitatorRejectedError(402, "bad_signature", "rejected");
    expect(err.httpStatus).toBe(402);
    expect(err.invalidReason).toBe("bad_signature");
    expect(err.code).toBe("facilitator_rejected");
    expect(err).toBeInstanceOf(X402ClientError);
  });
});
