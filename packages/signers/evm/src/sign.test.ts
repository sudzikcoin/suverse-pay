import { describe, expect, it } from "vitest";
import { recoverTypedDataAddress } from "viem";
import { signPaymentPayload } from "./sign.js";
import {
  allDomains,
  chainIdFromNetwork,
  getDomain,
  type EvmTokenDomain,
} from "./domains.js";
import {
  buildDomain,
  buildMessage,
  PRIMARY_TYPE,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
} from "./eip3009.js";
import type { PaymentRequirements } from "./types.js";

// Canonical BIP-39 test mnemonic — publicly known, NEVER associated with real funds.
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// Confirmed in Sub-task 1 + matches every other BIP-39 implementation at HD path m/44'/60'/0'/0/0.
const TEST_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
// Random hex private key fixture, not associated with any real wallet.
const TEST_PRIVATE_KEY =
  "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
// The address viem's privateKeyToAccount derives from TEST_PRIVATE_KEY
// (deterministic — match was measured at test-suite bootstrap and
// pinned here so future viem upgrades that change derivation surface
// as a test failure).
const TEST_PK_ADDRESS = "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23";

function networkFromChain(chainId: number): string {
  return `eip155:${chainId}`;
}

function makeRequirements(domain: EvmTokenDomain, overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: networkFromChain(domain.chainId),
    maxAmountRequired: "1000000",
    asset: domain.verifyingContract,
    payTo: "0x000000000000000000000000000000000000dEaD",
    resource: "https://suverse-pay.example/v1/smoke",
    maxTimeoutSeconds: 60,
    extra: {
      name: domain.name,
      version: domain.version,
      decimals: domain.decimals,
      symbol: domain.symbol,
    },
    ...overrides,
  };
}

describe("signPaymentPayload", () => {
  it("derives the canonical Ethereum address for the canonical mnemonic", async () => {
    const baseUsdc = getDomain(8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(baseUsdc).not.toBeNull();
    if (!baseUsdc) return;
    const { paymentPayload } = await signPaymentPayload({
      secret: TEST_MNEMONIC,
      network: "eip155:8453",
      requirements: makeRequirements(baseUsdc),
      amount: "1000000",
    });
    expect(paymentPayload.payload.authorization.from).toBe(TEST_ADDRESS);
  });

  it("derives a different address from a raw private key", async () => {
    const baseUsdc = getDomain(8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")!;
    const { paymentPayload } = await signPaymentPayload({
      secret: TEST_PRIVATE_KEY,
      network: "eip155:8453",
      requirements: makeRequirements(baseUsdc),
      amount: "1000000",
    });
    expect(paymentPayload.payload.authorization.from).toBe(TEST_PK_ADDRESS);
  });

  it("produces a 65-byte 0x-prefixed signature (132 hex chars + 0x)", async () => {
    const baseUsdc = getDomain(8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")!;
    const { paymentPayload } = await signPaymentPayload({
      secret: TEST_MNEMONIC,
      network: "eip155:8453",
      requirements: makeRequirements(baseUsdc),
      amount: "1000000",
    });
    expect(paymentPayload.payload.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
  });

  it("populates authorization fields correctly", async () => {
    const baseUsdc = getDomain(8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")!;
    const now = 1_700_000_000;
    const { paymentPayload } = await signPaymentPayload({
      secret: TEST_MNEMONIC,
      network: "eip155:8453",
      requirements: makeRequirements(baseUsdc),
      amount: "1000000",
      validitySeconds: 30,
      now,
    });
    const auth = paymentPayload.payload.authorization;
    expect(auth.value).toBe("1000000");
    expect(auth.validAfter).toBe((now - 2).toString());
    expect(auth.validBefore).toBe((now - 2 + 30).toString());
    expect(BigInt(auth.validBefore) - BigInt(auth.validAfter)).toBe(30n);
    expect(auth.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(auth.to).toBe("0x000000000000000000000000000000000000dEaD");
  });

  it("rejects unsupported network (BNB Chain 56 — Permit-only, no signer entry)", async () => {
    // Ethereum mainnet (1) and Optimism (10) became supported in
    // Phase 4 Block 1 Sub-task 3 (Thirdweb adapter); BNB Chain (56)
    // remains unsupported because its USDC contract uses EIP-2612
    // Permit not EIP-3009 — our signer doesn't produce Permit
    // signatures yet (separate sub-task).
    const baseUsdc = getDomain(8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")!;
    await expect(
      signPaymentPayload({
        secret: TEST_MNEMONIC,
        network: "eip155:56",
        requirements: makeRequirements(baseUsdc, { network: "eip155:56" }),
        amount: "1000000",
      }),
    ).rejects.toThrow(/unsupported chain|chain 56|8453|137|42161/);
  });

  it("rejects unknown ERC-20 contract on a supported chain", async () => {
    const baseUsdc = getDomain(8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")!;
    await expect(
      signPaymentPayload({
        secret: TEST_MNEMONIC,
        network: "eip155:8453",
        requirements: makeRequirements(baseUsdc, {
          asset: "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT on Ethereum, not in our Base table
        }),
        amount: "1000000",
      }),
    ).rejects.toThrow(/no trusted EIP-712 domain/);
  });

  it("rejects requirements.extra.name disagreeing with trusted domain", async () => {
    const baseUsdc = getDomain(8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")!;
    await expect(
      signPaymentPayload({
        secret: TEST_MNEMONIC,
        network: "eip155:8453",
        requirements: makeRequirements(baseUsdc, {
          extra: { name: "Fake Coin", version: "2" },
        }),
        amount: "1000000",
      }),
    ).rejects.toThrow(/disagrees with trusted/);
  });

  it("rejects validitySeconds exceeding maxTimeoutSeconds", async () => {
    const baseUsdc = getDomain(8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")!;
    await expect(
      signPaymentPayload({
        secret: TEST_MNEMONIC,
        network: "eip155:8453",
        requirements: makeRequirements(baseUsdc, { maxTimeoutSeconds: 30 }),
        amount: "1000000",
        validitySeconds: 60,
      }),
    ).rejects.toThrow(/maxTimeoutSeconds/);
  });

  it("rejects invalid mnemonic", async () => {
    const baseUsdc = getDomain(8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")!;
    await expect(
      signPaymentPayload({
        secret: "one two three",
        network: "eip155:8453",
        requirements: makeRequirements(baseUsdc),
        amount: "1000000",
      }),
    ).rejects.toThrow(/mnemonic|words/);
  });

  it("rejects malformed private key", async () => {
    const baseUsdc = getDomain(8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")!;
    await expect(
      signPaymentPayload({
        secret: "0xZZZZ",
        network: "eip155:8453",
        requirements: makeRequirements(baseUsdc),
        amount: "1000000",
      }),
    ).rejects.toThrow();
  });

  it("two signs with different now produce different validAfter and different nonces", async () => {
    const baseUsdc = getDomain(8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")!;
    const a = await signPaymentPayload({
      secret: TEST_MNEMONIC,
      network: "eip155:8453",
      requirements: makeRequirements(baseUsdc),
      amount: "1000000",
      now: 1_700_000_000,
    });
    const b = await signPaymentPayload({
      secret: TEST_MNEMONIC,
      network: "eip155:8453",
      requirements: makeRequirements(baseUsdc),
      amount: "1000000",
      now: 1_700_000_500,
    });
    expect(a.paymentPayload.payload.authorization.from).toBe(
      b.paymentPayload.payload.authorization.from,
    );
    expect(a.paymentPayload.payload.authorization.validAfter).not.toBe(
      b.paymentPayload.payload.authorization.validAfter,
    );
    expect(a.paymentPayload.payload.authorization.nonce).not.toBe(
      b.paymentPayload.payload.authorization.nonce,
    );
  });
});

/**
 * Round-trip recovery: for every trusted (chain, token) pair, sign a
 * payload and assert that viem's `recoverTypedDataAddress` returns the
 * exact signing account address. This proves EIP-712 mathematical
 * correctness (domain construction, type hash, signing primitives are
 * all consistent). It does NOT prove the (name, version, address)
 * triple is the real on-chain contract's domain — only CDP smoke can.
 *
 * Per Sub-task 3 plan: this is the critical gate for v0.2.0; all
 * pairs must pass before commit.
 */
describe("round-trip recovery (EIP-712 self-consistency)", () => {
  for (const domain of allDomains()) {
    it(`recovers signing address for ${domain.symbol} on chain ${domain.chainId} (${domain.name} v${domain.version})`, async () => {
      const { paymentPayload, paymentRequirements } = await signPaymentPayload({
        secret: TEST_MNEMONIC,
        network: networkFromChain(domain.chainId),
        requirements: makeRequirements(domain),
        amount: "1000000",
      });

      // Re-derive the domain the way the signer did, from the same
      // trusted table — not from paymentRequirements.extra — so this
      // is a true self-consistency check.
      const recovered = await recoverTypedDataAddress({
        domain: buildDomain(domain),
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: PRIMARY_TYPE,
        message: buildMessage(paymentPayload.payload.authorization),
        signature: paymentPayload.payload.signature,
      });

      expect(recovered).toBe(TEST_ADDRESS);
      // Also assert that paymentPayload.payload.authorization.from
      // agrees, which closes the loop.
      expect(paymentPayload.payload.authorization.from).toBe(TEST_ADDRESS);
      // And that the requirements that came back are the ones we
      // asked for — no in-place mutation.
      expect(paymentRequirements.asset).toBe(domain.verifyingContract);
      expect(chainIdFromNetwork(paymentRequirements.network)).toBe(domain.chainId);
    });
  }
});
