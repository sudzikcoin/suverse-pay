import { describe, expect, it } from "vitest";
import { fromBase64 } from "@cosmjs/encoding";
import { signPaymentPayload } from "./sign.js";
import { deriveCosmosKey } from "./derive.js";
import type { PaymentRequirements } from "./types.js";

// Canonical BIP-39 test mnemonic — publicly known, NEVER associated with real funds.
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// Confirmed in Sub-task 1 (apps/mcp init_session test).
const EXPECTED_NOBLE_ADDRESS = "noble19rl4cm2hmr8afy4kldpxz3fka4jguq0a5rc48m";

function makeRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact_cosmos_authz",
    network: "cosmos:grand-1",
    maxAmountRequired: "10000",
    asset: "uusdc",
    payTo: EXPECTED_NOBLE_ADDRESS,
    resource: "https://suverse-pay.example/v1/smoke",
    maxTimeoutSeconds: 60,
    extra: {
      facilitator: "noble1xe8469hdzc7t65jlxwxhhp48tkk3w0uykewsuy",
      chainId: "grand-1",
    },
    ...overrides,
  };
}

describe("signPaymentPayload", () => {
  it("signs against the canonical test mnemonic producing the known noble address", async () => {
    const result = await signPaymentPayload({
      mnemonic: TEST_MNEMONIC,
      network: "cosmos:grand-1",
      requirements: makeRequirements(),
      amount: "10000",
    });
    expect(result.paymentPayload.payload.from).toBe(EXPECTED_NOBLE_ADDRESS);
    expect(result.paymentPayload.payload.authorization.from).toBe(EXPECTED_NOBLE_ADDRESS);
    expect(result.paymentPayload.scheme).toBe("exact_cosmos_authz");
    expect(result.paymentPayload.network).toBe("cosmos:grand-1");
    expect(result.paymentPayload.x402Version).toBe(2);
  });

  it("produces a 64-byte raw r||s signature (NOT DER)", async () => {
    const { paymentPayload } = await signPaymentPayload({
      mnemonic: TEST_MNEMONIC,
      network: "cosmos:grand-1",
      requirements: makeRequirements(),
      amount: "10000",
    });
    const decoded = fromBase64(paymentPayload.payload.signature);
    expect(decoded.length).toBe(64);
  });

  it("produces a 33-byte compressed secp256k1 pub key", async () => {
    const { paymentPayload } = await signPaymentPayload({
      mnemonic: TEST_MNEMONIC,
      network: "cosmos:grand-1",
      requirements: makeRequirements(),
      amount: "10000",
    });
    const decoded = fromBase64(paymentPayload.payload.publicKey);
    expect(decoded.length).toBe(33);
    // SEC1 compressed pubkey first byte: 0x02 or 0x03.
    expect([0x02, 0x03]).toContain(decoded[0]);
  });

  it("pub key in payload matches re-derivation from the same mnemonic", async () => {
    const direct = await deriveCosmosKey(TEST_MNEMONIC, "noble");
    const { paymentPayload } = await signPaymentPayload({
      mnemonic: TEST_MNEMONIC,
      network: "cosmos:grand-1",
      requirements: makeRequirements(),
      amount: "10000",
    });
    const signedPubkey = fromBase64(paymentPayload.payload.publicKey);
    expect(signedPubkey).toEqual(direct.pubkeyCompressed);
    expect(paymentPayload.payload.from).toBe(direct.address);
  });

  it("respects the requested validity window", async () => {
    const now = 1_700_000_000;
    const { paymentPayload } = await signPaymentPayload({
      mnemonic: TEST_MNEMONIC,
      network: "cosmos:grand-1",
      requirements: makeRequirements(),
      amount: "10000",
      validitySeconds: 30,
      now,
    });
    const auth = paymentPayload.payload.authorization;
    expect(auth.validAfter).toBe(now - 2);
    expect(auth.validBefore).toBe(auth.validAfter + 30);
    expect(auth.validBefore - auth.validAfter).toBe(30);
  });

  it("rejects validitySeconds exceeding maxTimeoutSeconds", async () => {
    await expect(
      signPaymentPayload({
        mnemonic: TEST_MNEMONIC,
        network: "cosmos:grand-1",
        requirements: makeRequirements({ maxTimeoutSeconds: 30 }),
        amount: "10000",
        validitySeconds: 60,
      }),
    ).rejects.toThrow(/maxTimeoutSeconds/);
  });

  it("rejects unsupported network", async () => {
    await expect(
      signPaymentPayload({
        mnemonic: TEST_MNEMONIC,
        network: "cosmos:noble-1",
        requirements: makeRequirements({ network: "cosmos:noble-1", extra: { facilitator: "x", chainId: "noble-1" } }),
        amount: "10000",
      }),
    ).rejects.toThrow(/unsupported network|cosmos:grand-1/);
  });

  it("rejects when network does not match requirements.network", async () => {
    await expect(
      signPaymentPayload({
        mnemonic: TEST_MNEMONIC,
        network: "cosmos:grand-1",
        requirements: makeRequirements({ network: "cosmos:noble-1" }),
        amount: "10000",
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("rejects invalid mnemonic (wrong word count)", async () => {
    await expect(
      signPaymentPayload({
        mnemonic: "one two three",
        network: "cosmos:grand-1",
        requirements: makeRequirements(),
        amount: "10000",
      }),
    ).rejects.toThrow();
  });

  it("two signs with different now produce different validAfter but identical payer", async () => {
    const reqs = makeRequirements();
    const a = await signPaymentPayload({
      mnemonic: TEST_MNEMONIC,
      network: "cosmos:grand-1",
      requirements: reqs,
      amount: "10000",
      now: 1_700_000_000,
    });
    const b = await signPaymentPayload({
      mnemonic: TEST_MNEMONIC,
      network: "cosmos:grand-1",
      requirements: reqs,
      amount: "10000",
      now: 1_700_000_500,
    });
    expect(a.paymentPayload.payload.from).toBe(b.paymentPayload.payload.from);
    expect(a.paymentPayload.payload.publicKey).toBe(b.paymentPayload.payload.publicKey);
    expect(a.paymentPayload.payload.authorization.validAfter).not.toBe(
      b.paymentPayload.payload.authorization.validAfter,
    );
    // Different nonces too.
    expect(a.paymentPayload.payload.authorization.nonce).not.toBe(
      b.paymentPayload.payload.authorization.nonce,
    );
  });

  it("nonce is 0x-prefixed 32-byte hex (66 chars)", async () => {
    const { paymentPayload } = await signPaymentPayload({
      mnemonic: TEST_MNEMONIC,
      network: "cosmos:grand-1",
      requirements: makeRequirements(),
      amount: "10000",
    });
    expect(paymentPayload.payload.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
