import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { signPaymentPayload } from "./sign.js";
import {
  deriveKeypair,
  deriveKeypairFromMnemonic,
  keypairFromBase58SecretKey,
} from "./derive.js";
import {
  MEMO_PROGRAM_ID,
  buildMemoInstruction,
  buildTransferChecked,
} from "./transferChecked.js";
import {
  SCHEME,
  SOLANA_MAINNET,
  type PaymentRequirements,
} from "./types.js";

// Canonical BIP-39 test mnemonic — publicly known, NEVER associated with real funds.
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// Solana address derived from the canonical BIP-39 test mnemonic at the
// standard `m/44'/501'/0'/0'` derivation path. Measured at test-suite
// bootstrap with @solana/web3.js's `Keypair.fromSeed` over the
// ed25519-hd-key path output, and pinned here so any future drift in
// ed25519-hd-key, bip39, or @solana/web3.js surfaces as a test failure.
const TEST_ADDRESS = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";

// USDC mainnet SPL mint.
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// Random fixture pubkeys (NOT real wallets).
const TEST_RECIPIENT = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const TEST_FACILITATOR = "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd";

// Deterministic blockhash for tests. Real blockhashes are base58 of a
// recent block's hash; this one is just a 32-byte sentinel.
const TEST_BLOCKHASH = bs58.encode(Buffer.alloc(32, 7));

function makeRequirements(
  overrides: Partial<PaymentRequirements> = {},
): PaymentRequirements {
  return {
    scheme: SCHEME,
    network: SOLANA_MAINNET,
    maxAmountRequired: "1000",
    asset: USDC_MINT,
    payTo: TEST_RECIPIENT,
    resource: "https://example.com/premium",
    maxTimeoutSeconds: 60,
    extra: {
      feePayer: TEST_FACILITATOR,
      decimals: 6,
      symbol: "USDC",
    },
    ...overrides,
  };
}

describe("deriveKeypairFromMnemonic", () => {
  it("derives the canonical Solana address for the canonical BIP-39 test mnemonic", () => {
    const kp = deriveKeypairFromMnemonic(TEST_MNEMONIC);
    expect(kp.publicKey.toBase58()).toBe(TEST_ADDRESS);
  });

  it("rejects an invalid mnemonic with a sanitized message", () => {
    expect(() => deriveKeypairFromMnemonic("one two three")).toThrow(/invalid mnemonic/);
  });
});

describe("keypairFromBase58SecretKey", () => {
  it("round-trips a freshly generated Keypair's secret key", () => {
    const fresh = Keypair.generate();
    const recovered = keypairFromBase58SecretKey(bs58.encode(fresh.secretKey));
    expect(recovered.publicKey.toBase58()).toBe(fresh.publicKey.toBase58());
  });

  it("rejects a too-short base58 string", () => {
    expect(() => keypairFromBase58SecretKey(bs58.encode(Buffer.alloc(8)))).toThrow(
      /expected 64-byte secret key/,
    );
  });

  it("rejects malformed base58", () => {
    expect(() => keypairFromBase58SecretKey("0OIl invalid base58!")).toThrow(
      /invalid base58/,
    );
  });
});

describe("deriveKeypair (auto-detect)", () => {
  it("routes mnemonic input to mnemonic derivation", () => {
    const kp = deriveKeypair(TEST_MNEMONIC);
    expect(kp.publicKey.toBase58()).toBe(TEST_ADDRESS);
  });

  it("routes base58 input to secret-key derivation", () => {
    const fresh = Keypair.generate();
    const kp = deriveKeypair(bs58.encode(fresh.secretKey));
    expect(kp.publicKey.toBase58()).toBe(fresh.publicKey.toBase58());
  });
});

describe("buildMemoInstruction", () => {
  it("produces a Memo program instruction with UTF-8 data", () => {
    const ix = buildMemoInstruction("hello, world");
    expect(ix.programId.toBase58()).toBe(MEMO_PROGRAM_ID.toBase58());
    expect(ix.data.toString("utf8")).toBe("hello, world");
    expect(ix.keys).toEqual([]);
  });
});

describe("buildTransferChecked", () => {
  it("derives source ATA, destination ATA, and produces a valid transferChecked", () => {
    const owner = new PublicKey(TEST_ADDRESS);
    const recipient = new PublicKey(TEST_RECIPIENT);
    const mint = new PublicKey(USDC_MINT);
    const { instruction, sourceAta, destinationAta } = buildTransferChecked({
      mint,
      ownerPubkey: owner,
      recipientPubkey: recipient,
      amount: 1000n,
      decimals: 6,
    });
    expect(instruction.programId.toBase58()).toBe(
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    );
    // Source ATA must be derived from (owner, mint); destination from (recipient, mint).
    // The two should be different but both be 32-byte PublicKeys.
    expect(sourceAta.toBase58()).not.toBe(destinationAta.toBase58());
    expect(sourceAta.toBytes().length).toBe(32);
    expect(destinationAta.toBytes().length).toBe(32);
    // Order of account keys in transferChecked: [source, mint, destination, owner, ...].
    expect(instruction.keys[0]?.pubkey.toBase58()).toBe(sourceAta.toBase58());
    expect(instruction.keys[1]?.pubkey.toBase58()).toBe(mint.toBase58());
    expect(instruction.keys[2]?.pubkey.toBase58()).toBe(destinationAta.toBase58());
    expect(instruction.keys[3]?.pubkey.toBase58()).toBe(owner.toBase58());
  });
});

describe("signPaymentPayload", () => {
  it("returns a SignedRequest with x402Version=2, scheme=exact, mainnet network", async () => {
    const result = await signPaymentPayload({
      secret: TEST_MNEMONIC,
      network: SOLANA_MAINNET,
      requirements: makeRequirements(),
      amount: "1000",
      recentBlockhash: TEST_BLOCKHASH,
    });
    expect(result.paymentPayload.x402Version).toBe(2);
    expect(result.paymentPayload.scheme).toBe("exact");
    expect(result.paymentPayload.network).toBe(SOLANA_MAINNET);
    expect(typeof result.paymentPayload.payload.transaction).toBe("string");
  });

  it("produces a base64-encoded transaction that deserializes back to a VersionedTransaction", async () => {
    const result = await signPaymentPayload({
      secret: TEST_MNEMONIC,
      network: SOLANA_MAINNET,
      requirements: makeRequirements(),
      amount: "1000",
      recentBlockhash: TEST_BLOCKHASH,
    });
    const bytes = Buffer.from(result.paymentPayload.payload.transaction, "base64");
    const tx = VersionedTransaction.deserialize(bytes);
    expect(tx.message.version).toBe(0);
    // 2 ComputeBudget + 1 TransferChecked + 1 Memo = 4 compiled instructions.
    expect(tx.message.compiledInstructions.length).toBe(4);
  });

  it("emits exactly the instruction layout required by the SVM spec: cu-limit, cu-price, transferChecked, memo", async () => {
    const result = await signPaymentPayload({
      secret: TEST_MNEMONIC,
      network: SOLANA_MAINNET,
      requirements: makeRequirements({ extra: { feePayer: TEST_FACILITATOR, memo: "invoice_42", decimals: 6 } }),
      amount: "1000",
      recentBlockhash: TEST_BLOCKHASH,
    });
    const bytes = Buffer.from(result.paymentPayload.payload.transaction, "base64");
    const tx = VersionedTransaction.deserialize(bytes);
    const accountKeys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    const programIds = tx.message.compiledInstructions.map((ci) =>
      accountKeys[ci.programIdIndex],
    );
    expect(programIds).toEqual([
      "ComputeBudget111111111111111111111111111111",
      "ComputeBudget111111111111111111111111111111",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      MEMO_PROGRAM_ID.toBase58(),
    ]);
    // Memo data is the seller-supplied value, not a random nonce.
    const memoIx = tx.message.compiledInstructions[3];
    expect(memoIx).toBeDefined();
    if (memoIx) {
      expect(Buffer.from(memoIx.data).toString("utf8")).toBe("invoice_42");
    }
  });

  it("uses a random 16-byte hex memo when extra.memo is absent (32 hex chars)", async () => {
    const result = await signPaymentPayload({
      secret: TEST_MNEMONIC,
      network: SOLANA_MAINNET,
      requirements: makeRequirements(),
      amount: "1000",
      recentBlockhash: TEST_BLOCKHASH,
    });
    const bytes = Buffer.from(result.paymentPayload.payload.transaction, "base64");
    const tx = VersionedTransaction.deserialize(bytes);
    const memoIx = tx.message.compiledInstructions[3];
    if (memoIx) {
      const memoText = Buffer.from(memoIx.data).toString("utf8");
      expect(memoText).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("sets the feePayer to extra.feePayer (NOT the payer)", async () => {
    const result = await signPaymentPayload({
      secret: TEST_MNEMONIC,
      network: SOLANA_MAINNET,
      requirements: makeRequirements(),
      amount: "1000",
      recentBlockhash: TEST_BLOCKHASH,
    });
    const bytes = Buffer.from(result.paymentPayload.payload.transaction, "base64");
    const tx = VersionedTransaction.deserialize(bytes);
    // The transaction's fee payer is staticAccountKeys[0].
    expect(tx.message.staticAccountKeys[0]?.toBase58()).toBe(TEST_FACILITATOR);
  });

  it("rejects unsupported network", async () => {
    await expect(
      signPaymentPayload({
        secret: TEST_MNEMONIC,
        network: "solana:devnet",
        requirements: makeRequirements({ network: "solana:devnet" }),
        amount: "1000",
        recentBlockhash: TEST_BLOCKHASH,
      }),
    ).rejects.toThrow(/unsupported network/);
  });

  it("rejects when amount disagrees with requirements.maxAmountRequired (exact scheme)", async () => {
    await expect(
      signPaymentPayload({
        secret: TEST_MNEMONIC,
        network: SOLANA_MAINNET,
        requirements: makeRequirements({ maxAmountRequired: "1000" }),
        amount: "999",
        recentBlockhash: TEST_BLOCKHASH,
      }),
    ).rejects.toThrow(/must equal requirements\.maxAmountRequired/);
  });

  it("rejects when extra.feePayer is missing", async () => {
    await expect(
      signPaymentPayload({
        secret: TEST_MNEMONIC,
        network: SOLANA_MAINNET,
        requirements: makeRequirements({
          extra: { feePayer: "", decimals: 6 },
        }),
        amount: "1000",
        recentBlockhash: TEST_BLOCKHASH,
      }),
    ).rejects.toThrow(/extra\.feePayer/);
  });

  it("rejects when extra.feePayer equals the payer's pubkey (fee-payer safety)", async () => {
    await expect(
      signPaymentPayload({
        secret: TEST_MNEMONIC,
        network: SOLANA_MAINNET,
        requirements: makeRequirements({
          extra: { feePayer: TEST_ADDRESS, decimals: 6 },
        }),
        amount: "1000",
        recentBlockhash: TEST_BLOCKHASH,
      }),
    ).rejects.toThrow(/feePayer equals the payer/);
  });

  it("rejects unknown mint without an explicit extra.decimals", async () => {
    await expect(
      signPaymentPayload({
        secret: TEST_MNEMONIC,
        network: SOLANA_MAINNET,
        requirements: {
          scheme: SCHEME,
          network: SOLANA_MAINNET,
          maxAmountRequired: "1000",
          asset: "11111111111111111111111111111111",
          payTo: TEST_RECIPIENT,
          resource: "https://example.com/premium",
          maxTimeoutSeconds: 60,
          extra: { feePayer: TEST_FACILITATOR },
        },
        amount: "1000",
        recentBlockhash: TEST_BLOCKHASH,
      }),
    ).rejects.toThrow(/cannot determine token decimals/);
  });

  it("rejects oversized memo (>256 bytes)", async () => {
    await expect(
      signPaymentPayload({
        secret: TEST_MNEMONIC,
        network: SOLANA_MAINNET,
        requirements: makeRequirements({
          extra: { feePayer: TEST_FACILITATOR, memo: "a".repeat(257), decimals: 6 },
        }),
        amount: "1000",
        recentBlockhash: TEST_BLOCKHASH,
      }),
    ).rejects.toThrow(/256 bytes/);
  });

  it("two signs with different memo override produce different signatures", async () => {
    const a = await signPaymentPayload({
      secret: TEST_MNEMONIC,
      network: SOLANA_MAINNET,
      requirements: makeRequirements(),
      amount: "1000",
      recentBlockhash: TEST_BLOCKHASH,
      memoOverride: "memo-a",
    });
    const b = await signPaymentPayload({
      secret: TEST_MNEMONIC,
      network: SOLANA_MAINNET,
      requirements: makeRequirements(),
      amount: "1000",
      recentBlockhash: TEST_BLOCKHASH,
      memoOverride: "memo-b",
    });
    expect(a.paymentPayload.payload.transaction).not.toBe(
      b.paymentPayload.payload.transaction,
    );
  });
});

/**
 * Round-trip verification gate — CRITICAL.
 *
 * Without a Coinbase CDP or PayAI API key we can't submit to chain,
 * so the offline correctness gate for signer-solana is:
 *   1. Sign a payload.
 *   2. Deserialize the transaction.
 *   3. Manually verify the payer's signature against the canonical
 *      message bytes using `nacl.sign.detached.verify`.
 *   4. Confirm the recovered pubkey matches the derived payer.
 *
 * This proves the signing primitives, message construction, and
 * VersionedTransaction encoding are all internally consistent. It
 * does NOT prove the transaction would land on-chain (that requires
 * a live facilitator), but it does prove the math.
 */
describe("round-trip signature verification (offline gate)", () => {
  it("payer's signature verifies against the message bytes via nacl.sign.detached.verify", async () => {
    const { paymentPayload } = await signPaymentPayload({
      secret: TEST_MNEMONIC,
      network: SOLANA_MAINNET,
      requirements: makeRequirements(),
      amount: "1000",
      recentBlockhash: TEST_BLOCKHASH,
    });
    const bytes = Buffer.from(paymentPayload.payload.transaction, "base64");
    const tx = VersionedTransaction.deserialize(bytes);

    // The payer is whichever staticAccountKey index matches our
    // derived payer. The fee payer is index 0 (facilitator); the
    // payer signing the SPL transfer is one of the other writable
    // signers.
    const expectedPayer = new PublicKey(TEST_ADDRESS);
    const staticKeys = tx.message.staticAccountKeys;
    const payerIndex = staticKeys.findIndex((k) => k.equals(expectedPayer));
    expect(payerIndex).toBeGreaterThanOrEqual(0);

    const signature = tx.signatures[payerIndex];
    expect(signature).toBeDefined();
    if (!signature) return;
    // Signature must be 64 bytes (ed25519).
    expect(signature.length).toBe(64);
    // The fee-payer slot (index 0) should be all-zero since the
    // facilitator hasn't signed yet.
    const feePayerSig = tx.signatures[0];
    if (feePayerSig) {
      expect(feePayerSig.every((b) => b === 0)).toBe(true);
    }

    const messageBytes = tx.message.serialize();
    const valid = nacl.sign.detached.verify(
      messageBytes,
      signature,
      expectedPayer.toBytes(),
    );
    expect(valid).toBe(true);
  });

  it("a tampered byte in the serialized message invalidates the signature", async () => {
    const { paymentPayload } = await signPaymentPayload({
      secret: TEST_MNEMONIC,
      network: SOLANA_MAINNET,
      requirements: makeRequirements(),
      amount: "1000",
      recentBlockhash: TEST_BLOCKHASH,
    });
    const bytes = Buffer.from(paymentPayload.payload.transaction, "base64");
    const tx = VersionedTransaction.deserialize(bytes);
    const expectedPayer = new PublicKey(TEST_ADDRESS);
    const payerIndex = tx.message.staticAccountKeys.findIndex((k) =>
      k.equals(expectedPayer),
    );
    const signature = tx.signatures[payerIndex];
    if (!signature) throw new Error("no signature");
    const tampered = tx.message.serialize();
    // Flip a bit in a place that's definitely inside the message body.
    const middle = Math.floor(tampered.length / 2);
    const target = tampered[middle];
    if (target === undefined) throw new Error("message empty");
    tampered[middle] = target ^ 0x01;
    const valid = nacl.sign.detached.verify(
      tampered,
      signature,
      expectedPayer.toBytes(),
    );
    expect(valid).toBe(false);
  });
});
