import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import {
  DEFAULT_GASFREE_DOMAIN_MAINNET,
  TRON_GASFREE_SCHEME,
  TronSigner,
  evmHexToTron,
  signTronPayment,
  toHeaderValue,
  tronToEvmHex,
  type GasfreeDomain,
} from "../src/signers/tron.js";
import {
  GASFREE_MIN_USDT_ATOMIC,
  TRON_MAINNET,
  TRON_NILE,
} from "../src/network/tron-networks.js";
import type { AcceptedRequirement } from "../src/types.js";
import {
  InsufficientAmountError,
  X402ClientError,
} from "../src/types.js";

const PRIV = generatePrivateKey();
const EVM_ADDR = privateKeyToAccount(PRIV).address;
const TRON_ADDR = evmHexToTron(EVM_ADDR);
const USDT_MAINNET = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_NILE = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
const RECEIVER_TRON = "TMpNsK3Dj2ehBwQ9Hv5PeFZboynD7JX2is";

// A non-zero verifying contract for tests so the placeholder guard
// doesn't fire. Real gasfree.io address would replace this.
const TEST_DOMAIN_MAINNET: GasfreeDomain = {
  ...DEFAULT_GASFREE_DOMAIN_MAINNET,
  verifyingContract: "0x" + "11".repeat(20) as `0x${string}`,
};
const TEST_DOMAIN_NILE: GasfreeDomain = {
  name: "GasFree",
  version: "V1.0.0",
  chainId: 3448148188,
  verifyingContract: "0x" + "22".repeat(20) as `0x${string}`,
};

function reqFor(
  network: string = TRON_MAINNET,
  overrides: Partial<AcceptedRequirement> = {},
): AcceptedRequirement {
  return {
    scheme: TRON_GASFREE_SCHEME,
    network,
    asset: network === TRON_MAINNET ? USDT_MAINNET : USDT_NILE,
    payTo: RECEIVER_TRON,
    amount: "1500000", // exactly $1.50 USDT — the gasfree minimum
    maxTimeoutSeconds: 60,
    extra: { name: "Tether USD", version: "1" },
    ...overrides,
  };
}

// ---------------------------------------------------------------
// Address conversion
// ---------------------------------------------------------------

describe("TRON address conversion", () => {
  it("evmHexToTron + tronToEvmHex round-trip", () => {
    const evm = "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0" as const;
    const tron = evmHexToTron(evm);
    expect(tron.startsWith("T")).toBe(true);
    expect(tron.length).toBe(34);
    const back = tronToEvmHex(tron);
    expect(back.toLowerCase()).toBe(evm.toLowerCase());
  });

  it("tronToEvmHex matches the canonical USDT contract → 0xa614f803b6fd780986a42c78ec9c7f77e6ded13c", () => {
    // TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t is the canonical USDT
    // mainnet TRC-20. Its 0x-form is well known.
    const back = tronToEvmHex("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
    expect(back.toLowerCase()).toBe(
      "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c",
    );
  });

  it("tronToEvmHex rejects non-T-prefix", () => {
    expect(() => tronToEvmHex("1bla")).toThrowError(X402ClientError);
  });

  it("evmHexToTron rejects non-hex", () => {
    expect(() => evmHexToTron("not-hex" as `0x${string}`)).toThrowError(
      X402ClientError,
    );
  });
});

// ---------------------------------------------------------------
// Construction
// ---------------------------------------------------------------

describe("TronSigner construction", () => {
  it("accepts a 0x-prefixed 64-hex private key", () => {
    expect(() => new TronSigner({ wallet: PRIV })).not.toThrow();
  });

  it("accepts a bare hex private key (no 0x)", () => {
    const bare = PRIV.slice(2);
    expect(() => new TronSigner({ wallet: bare })).not.toThrow();
  });

  it("rejects too-short key", () => {
    expect(() => new TronSigner({ wallet: "0xabc" })).toThrowError(
      X402ClientError,
    );
  });

  it("exposes the derived TRON base58 address", () => {
    const signer = new TronSigner({ wallet: PRIV });
    expect(signer.address).toBe(TRON_ADDR);
    expect(signer.address.startsWith("T")).toBe(true);
  });

  it("supportedNetworks + supportedSchemes match v0.1.0 scope", () => {
    expect(TronSigner.supportedNetworks()).toEqual([TRON_MAINNET, TRON_NILE]);
    expect(TronSigner.supportedSchemes()).toEqual([TRON_GASFREE_SCHEME]);
  });

  it("rejects zero validitySeconds", () => {
    expect(
      () => new TronSigner({ wallet: PRIV, validitySeconds: 0 }),
    ).toThrowError(X402ClientError);
  });
});

// ---------------------------------------------------------------
// Happy path (exact_gasfree)
// ---------------------------------------------------------------

describe("TronSigner.sign — exact_gasfree happy path", () => {
  it("produces a v2 envelope with gasfreeAuthorization on mainnet", async () => {
    const signer = new TronSigner({
      wallet: PRIV,
      gasfreeDomain: { mainnet: TEST_DOMAIN_MAINNET },
    });
    const envelope = await signer.sign({
      requirement: reqFor(),
      nowOverride: 1_700_000_000,
      nonceOverride: "12345",
    });
    expect(envelope.x402Version).toBe(2);
    expect(envelope.scheme).toBe(TRON_GASFREE_SCHEME);
    expect(envelope.network).toBe(TRON_MAINNET);

    const payload = envelope.payload as Record<string, unknown>;
    expect(payload.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
    const auth = payload.gasfreeAuthorization as Record<string, string>;
    expect(auth.token).toBe(USDT_MAINNET);
    expect(auth.user).toBe(TRON_ADDR);
    expect(auth.receiver).toBe(RECEIVER_TRON);
    expect(auth.value).toBe("1500000");
    expect(auth.nonce).toBe("12345");
    // deadline = now + min(60, 60) = 1700000060
    expect(auth.deadline).toBe("1700000060");
  });

  it("works on Nile testnet with the testnet domain", async () => {
    const signer = new TronSigner({
      wallet: PRIV,
      gasfreeDomain: { nile: TEST_DOMAIN_NILE },
    });
    const envelope = await signer.sign({
      requirement: reqFor(TRON_NILE),
      nowOverride: 1_700_000_000,
      nonceOverride: "42",
    });
    expect(envelope.network).toBe(TRON_NILE);
    const auth = (envelope.payload as Record<string, unknown>)
      .gasfreeAuthorization as Record<string, string>;
    expect(auth.token).toBe(USDT_NILE);
  });

  it("maxFee defaults to min(defaultMaxFee, value/2)", async () => {
    const signer = new TronSigner({
      wallet: PRIV,
      gasfreeDomain: { mainnet: TEST_DOMAIN_MAINNET },
      defaultMaxFeeAtomic: 100_000n,
    });
    const envelope = await signer.sign({
      requirement: reqFor(),
      nowOverride: 1_700_000_000,
      nonceOverride: "1",
    });
    const auth = (envelope.payload as Record<string, unknown>)
      .gasfreeAuthorization as Record<string, string>;
    // value = 1_500_000; defaultMaxFee = 100_000; value/2 = 750_000.
    // min(defaultMaxFee, value/2) = 100_000.
    expect(auth.maxFee).toBe("100000");
  });

  it("maxFee capped at value/2 when default exceeds", async () => {
    const signer = new TronSigner({
      wallet: PRIV,
      gasfreeDomain: { mainnet: TEST_DOMAIN_MAINNET },
      defaultMaxFeeAtomic: 10_000_000n, // unreasonably high
    });
    const envelope = await signer.sign({
      requirement: reqFor(),
      nowOverride: 1_700_000_000,
      nonceOverride: "1",
    });
    const auth = (envelope.payload as Record<string, unknown>)
      .gasfreeAuthorization as Record<string, string>;
    expect(auth.maxFee).toBe("750000"); // 1_500_000 / 2
  });

  it("signature recovers to the buyer's address via TIP-712", async () => {
    const signer = new TronSigner({
      wallet: PRIV,
      gasfreeDomain: { mainnet: TEST_DOMAIN_MAINNET },
    });
    const envelope = await signer.sign({
      requirement: reqFor(),
      nowOverride: 1_700_000_000,
      nonceOverride: "1",
    });
    const payload = envelope.payload as Record<string, unknown>;
    const auth = payload.gasfreeAuthorization as Record<string, string>;
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: TEST_DOMAIN_MAINNET.name,
        version: TEST_DOMAIN_MAINNET.version,
        chainId: TEST_DOMAIN_MAINNET.chainId,
        verifyingContract: TEST_DOMAIN_MAINNET.verifyingContract,
      },
      types: {
        PermitTransfer: [
          { name: "token", type: "address" },
          { name: "user", type: "address" },
          { name: "receiver", type: "address" },
          { name: "value", type: "uint256" },
          { name: "maxFee", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      },
      primaryType: "PermitTransfer",
      message: {
        token: tronToEvmHex(auth.token),
        user: tronToEvmHex(auth.user),
        receiver: tronToEvmHex(auth.receiver),
        value: BigInt(auth.value),
        maxFee: BigInt(auth.maxFee),
        deadline: BigInt(auth.deadline),
        nonce: BigInt(auth.nonce),
      },
      signature: payload.signature as `0x${string}`,
    });
    expect(recovered.toLowerCase()).toBe(EVM_ADDR.toLowerCase());
  });
});

// ---------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------

describe("TronSigner.sign — rejections", () => {
  it("throws InsufficientAmountError when amount < gasfree minimum", async () => {
    const signer = new TronSigner({
      wallet: PRIV,
      gasfreeDomain: { mainnet: TEST_DOMAIN_MAINNET },
    });
    await expect(
      signer.sign({
        requirement: reqFor(TRON_MAINNET, { amount: "100000" }), // $0.10
      }),
    ).rejects.toThrowError(InsufficientAmountError);
  });

  it("accepts amount exactly at minimum", async () => {
    const signer = new TronSigner({
      wallet: PRIV,
      gasfreeDomain: { mainnet: TEST_DOMAIN_MAINNET },
    });
    const envelope = await signer.sign({
      requirement: reqFor(TRON_MAINNET, {
        amount: GASFREE_MIN_USDT_ATOMIC.toString(),
      }),
      nowOverride: 1_700_000_000,
      nonceOverride: "1",
    });
    expect(envelope.network).toBe(TRON_MAINNET);
  });

  it("rejects exact scheme with phase-specific hint", async () => {
    const signer = new TronSigner({
      wallet: PRIV,
      gasfreeDomain: { mainnet: TEST_DOMAIN_MAINNET },
    });
    await expect(
      signer.sign({
        requirement: reqFor(TRON_MAINNET, { scheme: "exact" }),
      }),
    ).rejects.toThrowError(/exact_gasfree/);
  });

  it("rejects exact_permit scheme with phase-specific hint", async () => {
    const signer = new TronSigner({
      wallet: PRIV,
      gasfreeDomain: { mainnet: TEST_DOMAIN_MAINNET },
    });
    await expect(
      signer.sign({
        requirement: reqFor(TRON_MAINNET, { scheme: "exact_permit" }),
      }),
    ).rejects.toThrowError(/exact_gasfree/);
  });

  it("rejects unsupported tron:* network", async () => {
    const signer = new TronSigner({
      wallet: PRIV,
      gasfreeDomain: { mainnet: TEST_DOMAIN_MAINNET },
    });
    await expect(
      signer.sign({
        requirement: reqFor(TRON_MAINNET, { network: "tron:shasta" }),
      }),
    ).rejects.toThrowError(/recognised/);
  });

  it("rejects unknown TRC-20 asset", async () => {
    const signer = new TronSigner({
      wallet: PRIV,
      gasfreeDomain: { mainnet: TEST_DOMAIN_MAINNET },
    });
    await expect(
      signer.sign({
        requirement: reqFor(TRON_MAINNET, {
          asset: "TRtZNotARealTokenAddress12345678910",
        }),
      }),
    ).rejects.toThrowError(/registry/);
  });

  it("rejects placeholder gasfreeDomain (verifyingContract zero)", async () => {
    const signer = new TronSigner({ wallet: PRIV }); // default domains
    await expect(
      signer.sign({
        requirement: reqFor(),
      }),
    ).rejects.toThrowError(/placeholder/);
  });
});

// ---------------------------------------------------------------
// toHeaderValue + shim
// ---------------------------------------------------------------

describe("toHeaderValue + signTronPayment shim", () => {
  it("toHeaderValue produces base64 round-trippable JSON", async () => {
    const signer = new TronSigner({
      wallet: PRIV,
      gasfreeDomain: { mainnet: TEST_DOMAIN_MAINNET },
    });
    const env = await signer.sign({
      requirement: reqFor(),
      nowOverride: 1_700_000_000,
      nonceOverride: "1",
    });
    const header = toHeaderValue(env);
    expect(header).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const back = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    expect(back.scheme).toBe(TRON_GASFREE_SCHEME);
  });

  it("signTronPayment shim refuses bad domain", async () => {
    // The shim uses defaults; default mainnet domain is placeholder.
    await expect(
      signTronPayment({
        wallet: PRIV,
        requirement: reqFor(),
      }),
    ).rejects.toThrowError(/placeholder/);
  });
});
