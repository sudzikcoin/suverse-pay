import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { EvmSigner, toHeaderValue } from "../src/signers/evm.js";
import { CHAINS, lookupByCaip2 } from "../src/network/chains.js";
import type { AcceptedRequirement } from "../src/types.js";
import { X402ClientError } from "../src/types.js";

const TEST_PRIVKEY = generatePrivateKey();
const TEST_ACCOUNT = privateKeyToAccount(TEST_PRIVKEY);
const PAY_TO = "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0" as const;

function reqFor(network: string, amount = "100000"): AcceptedRequirement {
  const chain = lookupByCaip2(network)!;
  return {
    scheme: "exact",
    network: chain.caip2,
    asset: chain.usdc.address,
    payTo: PAY_TO,
    amount,
    maxTimeoutSeconds: 60,
    extra: {
      name: chain.usdc.eip712Name,
      version: chain.usdc.eip712Version,
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("EvmSigner construction", () => {
  it("accepts a 0x-prefixed private key", () => {
    expect(() => new EvmSigner({ wallet: TEST_PRIVKEY })).not.toThrow();
  });

  it("accepts a viem account object", () => {
    expect(() => new EvmSigner({ wallet: TEST_ACCOUNT })).not.toThrow();
  });

  it("rejects non-hex string", () => {
    expect(
      () => new EvmSigner({ wallet: "not-a-key" as `0x${string}` }),
    ).toThrowError(X402ClientError);
  });

  it("rejects too-short hex", () => {
    expect(
      () => new EvmSigner({ wallet: "0xabc" as `0x${string}` }),
    ).toThrowError(X402ClientError);
  });

  it("rejects zero validitySeconds", () => {
    expect(
      () => new EvmSigner({ wallet: TEST_PRIVKEY, validitySeconds: 0 }),
    ).toThrowError(X402ClientError);
  });

  it("supportedNetworks returns only eip3009-capable chains", () => {
    const list = EvmSigner.supportedNetworks();
    expect(list).toContain("eip155:8453");
    expect(list).toContain("eip155:1");
    expect(list).not.toContain("eip155:4217"); // Tempo — not eip3009
    expect(list).not.toContain("eip155:56"); // BNB — not eip3009
  });
});

describe("EvmSigner.sign — happy path", () => {
  it("produces a v2 envelope with the expected shape on Base", async () => {
    const signer = new EvmSigner({ wallet: TEST_PRIVKEY });
    const envelope = await signer.sign({
      requirement: reqFor("eip155:8453"),
      nowOverride: 1_700_000_000,
      nonceOverride: ("0x" + "ab".repeat(32)) as `0x${string}`,
    });
    expect(envelope.x402Version).toBe(2);
    expect(envelope.scheme).toBe("exact");
    expect(envelope.network).toBe("eip155:8453");
    expect(envelope.accepted.payTo).toBe(PAY_TO);
    const payload = envelope.payload as Record<string, unknown>;
    expect(payload.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
    const auth = payload.authorization as Record<string, string>;
    expect(auth.from).toBe(TEST_ACCOUNT.address);
    expect(auth.to).toBe(PAY_TO);
    expect(auth.value).toBe("100000");
    expect(auth.validAfter).toBe("1699999998");
    expect(auth.validBefore).toBe("1700000058");
    expect(auth.nonce).toBe("0x" + "ab".repeat(32));
  });

  it("base64-encodes envelope correctly via toHeaderValue", async () => {
    const signer = new EvmSigner({ wallet: TEST_PRIVKEY });
    const envelope = await signer.sign({
      requirement: reqFor("eip155:8453"),
      nowOverride: 1_700_000_000,
      nonceOverride: ("0x" + "01".repeat(32)) as `0x${string}`,
    });
    const header = toHeaderValue(envelope);
    expect(header).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.network).toBe("eip155:8453");
  });

  it("clamps validitySeconds to requirement.maxTimeoutSeconds", async () => {
    const signer = new EvmSigner({
      wallet: TEST_PRIVKEY,
      validitySeconds: 600,
    });
    const requirement: AcceptedRequirement = {
      ...reqFor("eip155:8453"),
      maxTimeoutSeconds: 30, // seller's cap is lower than signer default
    };
    const envelope = await signer.sign({
      requirement,
      nowOverride: 1_700_000_000,
      nonceOverride: ("0x" + "ff".repeat(32)) as `0x${string}`,
    });
    const auth = (envelope.payload as Record<string, unknown>)
      .authorization as Record<string, string>;
    expect(BigInt(auth.validBefore) - BigInt(auth.validAfter)).toBe(30n);
  });

  it("recovers signer address from the EIP-712 signature", async () => {
    const signer = new EvmSigner({ wallet: TEST_PRIVKEY });
    const envelope = await signer.sign({
      requirement: reqFor("eip155:8453"),
      nowOverride: 1_700_000_000,
      nonceOverride: ("0x" + "cd".repeat(32)) as `0x${string}`,
    });
    const chain = lookupByCaip2("eip155:8453")!;
    const payload = envelope.payload as Record<string, unknown>;
    const auth = payload.authorization as Record<string, string>;
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: chain.usdc.eip712Name,
        version: chain.usdc.eip712Version,
        chainId: chain.chainId,
        verifyingContract: chain.usdc.address,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from as `0x${string}`,
        to: auth.to as `0x${string}`,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce as `0x${string}`,
      },
      signature: payload.signature as `0x${string}`,
    });
    expect(recovered.toLowerCase()).toBe(TEST_ACCOUNT.address.toLowerCase());
  });
});

describe("EvmSigner.sign — coverage across all eip3009-capable chains", () => {
  const reachable = CHAINS.filter((c) => c.eip3009Supported);
  it.each(reachable.map((c) => [c.caip2, c.displayName] as const))(
    "signs successfully on %s (%s)",
    async (caip2) => {
      const signer = new EvmSigner({ wallet: TEST_PRIVKEY });
      const envelope = await signer.sign({
        requirement: reqFor(caip2),
        nowOverride: 1_700_000_000,
        nonceOverride: ("0x" + "11".repeat(32)) as `0x${string}`,
      });
      expect(envelope.network).toBe(caip2);
      expect(
        ((envelope.payload as Record<string, unknown>).signature as string)
          .length,
      ).toBe(132); // 0x + 65 bytes = 130 hex + 0x prefix
    },
  );
});

describe("EvmSigner.sign — rejections", () => {
  it("rejects a non-exact scheme", async () => {
    const signer = new EvmSigner({ wallet: TEST_PRIVKEY });
    await expect(
      signer.sign({
        requirement: { ...reqFor("eip155:8453"), scheme: "exact_permit" },
      }),
    ).rejects.toThrowError(/scheme/i);
  });

  it("rejects an unsupported chain", async () => {
    const signer = new EvmSigner({ wallet: TEST_PRIVKEY });
    await expect(
      signer.sign({
        requirement: {
          ...reqFor("eip155:8453"),
          network: "eip155:99999",
        },
      }),
    ).rejects.toThrowError(/registry/i);
  });

  it("rejects Tempo (eip3009Supported=false) with friendly message", async () => {
    const signer = new EvmSigner({ wallet: TEST_PRIVKEY });
    const chain = lookupByCaip2("eip155:4217")!;
    await expect(
      signer.sign({
        requirement: {
          scheme: "exact",
          network: chain.caip2,
          asset: chain.usdc.address,
          payTo: PAY_TO,
          amount: "100000",
          maxTimeoutSeconds: 60,
        },
      }),
    ).rejects.toThrowError(/EIP-3009/);
  });

  it("rejects when extra.name disagrees with trusted domain", async () => {
    const signer = new EvmSigner({ wallet: TEST_PRIVKEY });
    const base = reqFor("eip155:8453");
    await expect(
      signer.sign({
        requirement: {
          ...base,
          extra: { name: "Fake USDC", version: "2" },
        },
      }),
    ).rejects.toThrowError(/disagrees/);
  });

  it("rejects when asset address differs from registry", async () => {
    const signer = new EvmSigner({ wallet: TEST_PRIVKEY });
    const base = reqFor("eip155:8453");
    await expect(
      signer.sign({
        requirement: {
          ...base,
          asset: "0xdEAD000000000000000000000000000000000000",
        },
      }),
    ).rejects.toThrowError(/asset/i);
  });

  it("rejects non-EVM network family", async () => {
    const signer = new EvmSigner({ wallet: TEST_PRIVKEY });
    await expect(
      signer.sign({
        requirement: {
          ...reqFor("eip155:8453"),
          network: "solana:mainnet",
        },
      }),
    ).rejects.toThrowError(/not an eip155/);
  });
});
