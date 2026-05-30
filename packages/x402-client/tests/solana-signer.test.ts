import { describe, expect, it } from "vitest";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { SolanaSigner, toHeaderValue } from "../src/signers/solana.js";
import {
  SOLANA_DEVNET,
  SOLANA_MAINNET,
} from "../src/network/solana-networks.js";
import type { AcceptedRequirement } from "../src/types.js";
import { X402ClientError } from "../src/types.js";

const PAYER = Keypair.generate();
const PAYER_SECRET = bs58.encode(PAYER.secretKey);
const PAYER_SEED = PAYER.secretKey.slice(0, 32);

const FEE_PAYER = Keypair.generate();
const RECIPIENT = Keypair.generate();

const FIXED_BLOCKHASH = "GfVCmJgZ7CTRkXovHsaJoehZZQg6tfFK6kkAGE5JzPnX";

const USDC_MAINNET_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

function makeRequirement(
  network: string = SOLANA_MAINNET,
  overrides: Partial<AcceptedRequirement> = {},
): AcceptedRequirement {
  return {
    scheme: "exact",
    network,
    asset: network === SOLANA_MAINNET ? USDC_MAINNET_MINT : USDC_DEVNET_MINT,
    payTo: RECIPIENT.publicKey.toBase58(),
    amount: "100000", // $0.10 USDC
    maxTimeoutSeconds: 60,
    extra: {
      feePayer: FEE_PAYER.publicKey.toBase58(),
    },
    ...overrides,
  };
}

describe("SolanaSigner construction", () => {
  it("accepts a base58 64-byte secret key string", () => {
    expect(() => new SolanaSigner({ wallet: PAYER_SECRET })).not.toThrow();
  });

  it("accepts a 64-byte Uint8Array secret key", () => {
    expect(
      () => new SolanaSigner({ wallet: PAYER.secretKey }),
    ).not.toThrow();
  });

  it("accepts a 32-byte Uint8Array seed", () => {
    expect(() => new SolanaSigner({ wallet: PAYER_SEED })).not.toThrow();
  });

  it("rejects an empty wallet", () => {
    expect(() => new SolanaSigner({ wallet: "" })).toThrowError(
      X402ClientError,
    );
  });

  it("rejects a Uint8Array of wrong length", () => {
    expect(
      () => new SolanaSigner({ wallet: new Uint8Array(40) }),
    ).toThrowError(X402ClientError);
  });

  it("rejects garbage base58", () => {
    expect(
      () => new SolanaSigner({ wallet: "0OIl-not-base58" }),
    ).toThrowError(X402ClientError);
  });

  it("rejects compute unit price over the spec cap", () => {
    expect(
      () =>
        new SolanaSigner({
          wallet: PAYER_SECRET,
          computeUnitPriceMicroLamports: 10_000_000,
        }),
    ).toThrowError(X402ClientError);
  });

  it("exposes the derived base58 pubkey via .address", () => {
    const signer = new SolanaSigner({ wallet: PAYER_SECRET });
    expect(signer.address).toBe(PAYER.publicKey.toBase58());
  });

  it("supportedNetworks returns mainnet + devnet", () => {
    const list = SolanaSigner.supportedNetworks();
    expect(list).toContain(SOLANA_MAINNET);
    expect(list).toContain(SOLANA_DEVNET);
    expect(list).toHaveLength(2);
  });
});

describe("SolanaSigner.sign — happy path", () => {
  it("produces a v2 envelope with base64 VersionedTransaction on mainnet", async () => {
    const signer = new SolanaSigner({ wallet: PAYER_SECRET });
    const envelope = await signer.sign({
      requirement: makeRequirement(),
      recentBlockhash: FIXED_BLOCKHASH,
      memoOverride: "deterministic-memo-test",
    });
    expect(envelope.x402Version).toBe(2);
    expect(envelope.scheme).toBe("exact");
    expect(envelope.network).toBe(SOLANA_MAINNET);
    expect(envelope.accepted.amount).toBe("100000");
    const payload = envelope.payload as Record<string, unknown>;
    expect(typeof payload.transaction).toBe("string");
    // Sanity: base64 decodes to a real VersionedTransaction.
    const bytes = Buffer.from(payload.transaction as string, "base64");
    const decoded = VersionedTransaction.deserialize(bytes);
    expect(decoded.message.header.numRequiredSignatures).toBeGreaterThanOrEqual(
      1,
    );
    // Instruction count: ComputeBudget x2 + transferChecked + memo = 4
    expect(decoded.message.compiledInstructions).toHaveLength(4);
  });

  it("partial-signs as payer (1 populated signature, fee-payer slot zeroed)", async () => {
    const signer = new SolanaSigner({ wallet: PAYER_SECRET });
    const envelope = await signer.sign({
      requirement: makeRequirement(),
      recentBlockhash: FIXED_BLOCKHASH,
      memoOverride: "test",
    });
    const bytes = Buffer.from(
      (envelope.payload as Record<string, unknown>).transaction as string,
      "base64",
    );
    const decoded = VersionedTransaction.deserialize(bytes);
    // First signature slot is the fee payer per Solana convention —
    // it must stay zeroed until the facilitator co-signs.
    expect(decoded.signatures.length).toBeGreaterThanOrEqual(2);
    expect(decoded.signatures[0]!.every((b) => b === 0)).toBe(true);
    // The payer's signature should be non-zero somewhere in the array.
    const populated = decoded.signatures.filter(
      (s) => !s.every((b) => b === 0),
    );
    expect(populated.length).toBe(1);
  });

  it("works on devnet", async () => {
    const signer = new SolanaSigner({ wallet: PAYER_SECRET });
    const envelope = await signer.sign({
      requirement: makeRequirement(SOLANA_DEVNET),
      recentBlockhash: FIXED_BLOCKHASH,
      memoOverride: "test",
    });
    expect(envelope.network).toBe(SOLANA_DEVNET);
  });

  it("toHeaderValue produces base64 round-trippable JSON", async () => {
    const signer = new SolanaSigner({ wallet: PAYER_SECRET });
    const envelope = await signer.sign({
      requirement: makeRequirement(),
      recentBlockhash: FIXED_BLOCKHASH,
      memoOverride: "test",
    });
    const header = toHeaderValue(envelope);
    expect(header).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const back = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    expect(back.x402Version).toBe(2);
    expect(back.network).toBe(SOLANA_MAINNET);
  });
});

describe("SolanaSigner.sign — rejections", () => {
  it("rejects a non-exact scheme", async () => {
    const signer = new SolanaSigner({ wallet: PAYER_SECRET });
    await expect(
      signer.sign({
        requirement: makeRequirement(SOLANA_MAINNET, { scheme: "exact_permit" }),
        recentBlockhash: FIXED_BLOCKHASH,
      }),
    ).rejects.toThrowError(/scheme/);
  });

  it("rejects an unsupported network", async () => {
    const signer = new SolanaSigner({ wallet: PAYER_SECRET });
    await expect(
      signer.sign({
        requirement: makeRequirement(SOLANA_MAINNET, {
          network: "solana:unknown",
        }),
        recentBlockhash: FIXED_BLOCKHASH,
      }),
    ).rejects.toThrowError(/recognised/);
  });

  it("rejects missing extra.feePayer", async () => {
    const signer = new SolanaSigner({ wallet: PAYER_SECRET });
    await expect(
      signer.sign({
        requirement: makeRequirement(SOLANA_MAINNET, { extra: {} }),
        recentBlockhash: FIXED_BLOCKHASH,
      }),
    ).rejects.toThrowError(/feePayer/);
  });

  it("rejects when fee payer equals the source authority", async () => {
    const signer = new SolanaSigner({ wallet: PAYER_SECRET });
    const requirement = makeRequirement(SOLANA_MAINNET, {
      extra: { feePayer: PAYER.publicKey.toBase58() },
    });
    await expect(
      signer.sign({
        requirement,
        recentBlockhash: FIXED_BLOCKHASH,
      }),
    ).rejects.toThrowError(/forbids/i);
  });

  it("rejects an unknown mint without extra.decimals", async () => {
    const signer = new SolanaSigner({ wallet: PAYER_SECRET });
    const requirement = makeRequirement(SOLANA_MAINNET, {
      asset: Keypair.generate().publicKey.toBase58(),
      // No extra.decimals
      extra: { feePayer: FEE_PAYER.publicKey.toBase58() },
    });
    await expect(
      signer.sign({
        requirement,
        recentBlockhash: FIXED_BLOCKHASH,
      }),
    ).rejects.toThrowError(/decimals/);
  });

  it("accepts an unknown mint when extra.decimals is supplied", async () => {
    const signer = new SolanaSigner({ wallet: PAYER_SECRET });
    const requirement = makeRequirement(SOLANA_MAINNET, {
      asset: Keypair.generate().publicKey.toBase58(),
      extra: { feePayer: FEE_PAYER.publicKey.toBase58(), decimals: 9 },
    });
    const env = await signer.sign({
      requirement,
      recentBlockhash: FIXED_BLOCKHASH,
      memoOverride: "test",
    });
    expect(env.network).toBe(SOLANA_MAINNET);
  });

  it("rejects an oversize memo", async () => {
    const signer = new SolanaSigner({ wallet: PAYER_SECRET });
    await expect(
      signer.sign({
        requirement: makeRequirement(),
        recentBlockhash: FIXED_BLOCKHASH,
        memoOverride: "x".repeat(300),
      }),
    ).rejects.toThrowError(/256 bytes/);
  });

  it("rejects an invalid base58 pubkey in payTo", async () => {
    const signer = new SolanaSigner({ wallet: PAYER_SECRET });
    await expect(
      signer.sign({
        requirement: makeRequirement(SOLANA_MAINNET, { payTo: "not-a-pubkey" }),
        recentBlockhash: FIXED_BLOCKHASH,
      }),
    ).rejects.toThrowError(/pubkey/);
  });
});

describe("SolanaSigner.sign — determinism", () => {
  it("produces identical transaction bytes when memo + blockhash are pinned", async () => {
    const signer = new SolanaSigner({ wallet: PAYER_SECRET });
    const req = makeRequirement();
    const env1 = await signer.sign({
      requirement: req,
      recentBlockhash: FIXED_BLOCKHASH,
      memoOverride: "fixed-memo",
    });
    const env2 = await signer.sign({
      requirement: req,
      recentBlockhash: FIXED_BLOCKHASH,
      memoOverride: "fixed-memo",
    });
    expect((env1.payload as Record<string, unknown>).transaction).toBe(
      (env2.payload as Record<string, unknown>).transaction,
    );
  });

  it("different memo → different transaction", async () => {
    const signer = new SolanaSigner({ wallet: PAYER_SECRET });
    const req = makeRequirement();
    const env1 = await signer.sign({
      requirement: req,
      recentBlockhash: FIXED_BLOCKHASH,
      memoOverride: "memo-A",
    });
    const env2 = await signer.sign({
      requirement: req,
      recentBlockhash: FIXED_BLOCKHASH,
      memoOverride: "memo-B",
    });
    expect((env1.payload as Record<string, unknown>).transaction).not.toBe(
      (env2.payload as Record<string, unknown>).transaction,
    );
  });
});
