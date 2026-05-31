import { describe, expect, it } from "vitest";
import {
  deriveFacilitatorIdempotencyKey,
  extractPayerAddress,
  extractPayloadNonce,
} from "./idempotency-key.js";

describe("deriveFacilitatorIdempotencyKey", () => {
  const base = {
    resourceKeyId: "reskey_aaaaaaaa",
    payerAddress: "0xpayer",
    payloadNonce: "0xnonce0001",
    now: 1_700_000_000_000,
  };

  it("returns a 32-char hex string", () => {
    expect(deriveFacilitatorIdempotencyKey(base)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is deterministic for the same inputs within an hour bucket", () => {
    const a = deriveFacilitatorIdempotencyKey({ ...base, now: 1_700_000_000_000 });
    const b = deriveFacilitatorIdempotencyKey({ ...base, now: 1_700_000_000_000 + 60_000 });
    expect(a).toBe(b);
  });

  it("changes when resourceKeyId changes (per-tenant namespace)", () => {
    const a = deriveFacilitatorIdempotencyKey({ ...base, resourceKeyId: "reskey_alpha" });
    const b = deriveFacilitatorIdempotencyKey({ ...base, resourceKeyId: "reskey_beta" });
    expect(a).not.toBe(b);
  });

  it("changes when payer changes", () => {
    expect(
      deriveFacilitatorIdempotencyKey({ ...base, payerAddress: "0xa" }),
    ).not.toBe(
      deriveFacilitatorIdempotencyKey({ ...base, payerAddress: "0xb" }),
    );
  });

  it("changes when payload nonce changes", () => {
    expect(
      deriveFacilitatorIdempotencyKey({ ...base, payloadNonce: "0x1" }),
    ).not.toBe(
      deriveFacilitatorIdempotencyKey({ ...base, payloadNonce: "0x2" }),
    );
  });

  it("changes across hour boundaries (legitimate re-payment unblocked)", () => {
    const t = 1_700_000_000_000;
    expect(
      deriveFacilitatorIdempotencyKey({ ...base, now: t }),
    ).not.toBe(
      deriveFacilitatorIdempotencyKey({ ...base, now: t + 3_600_000 + 1 }),
    );
  });
});

describe("extractPayloadNonce", () => {
  it("returns authorization.nonce for EVM-shaped payloads", () => {
    expect(
      extractPayloadNonce({
        x402Version: 2,
        scheme: "exact",
        network: "eip155:8453",
        payload: {
          signature: "0xsig",
          authorization: { from: "0xpayer", nonce: "0xabcd1234" },
        },
      }),
    ).toBe("0xabcd1234");
  });

  it("returns authorization.nonce for Cosmos-shaped payloads", () => {
    expect(
      extractPayloadNonce({
        x402Version: 2,
        scheme: "exact_cosmos_authz",
        network: "cosmos:grand-1",
        payload: {
          from: "noble1payer",
          publicKey: "pk",
          signature: "sig",
          authorization: { nonce: "0xnonce" },
        },
      }),
    ).toBe("0xnonce");
  });

  it("returns sha256-prefix of the transaction for SVM-shaped payloads", () => {
    // sha256("AAAA1111BBBB2222CCCC3333DDDD4444EEEEextra") cross-checked
    // via `node -e "console.log(require('crypto').createHash('sha256').update('AAAA1111BBBB2222CCCC3333DDDD4444EEEEextra').digest('hex').slice(0,32))"`.
    expect(
      extractPayloadNonce({
        x402Version: 2,
        scheme: "exact",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        payload: { transaction: "AAAA1111BBBB2222CCCC3333DDDD4444EEEEextra" },
      }),
    ).toMatch(/^[0-9a-f]{32}$/);
  });

  it("distinguishes two SVM transactions sharing the leading-signatures prefix", () => {
    // Reproducer for the pre-fix collision. The buyer SDK serializes a
    // partially-signed VersionedTransaction whose wire format is
    //   [u16 sig-count] [feePayer sig: 64 zero bytes] [buyer sig: 64 bytes] [message...]
    // — the SDK only fills the buyer slot, leaving the feePayer slot
    // as a 64-byte zero placeholder. Base64 of the first 24 raw bytes
    // is `"AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"` regardless of memo or
    // blockhash, so a naive `transaction.slice(0, 32)` collapses every
    // fresh signing onto the same idempotency key. Hashing the full
    // blob restores per-payment entropy from the memo + buyer signature.
    const COMMON_ZERO_PREFIX = "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const txA = COMMON_ZERO_PREFIX + "BUYER_SIG_A_AND_MESSAGE_BYTES";
    const txB = COMMON_ZERO_PREFIX + "BUYER_SIG_B_AND_MESSAGE_BYTES";
    expect(txA.slice(0, 32)).toBe(txB.slice(0, 32));
    const nonceA = extractPayloadNonce({ payload: { transaction: txA } });
    const nonceB = extractPayloadNonce({ payload: { transaction: txB } });
    expect(nonceA).not.toBe(nonceB);
  });

  it("returns empty string for non-object input", () => {
    expect(extractPayloadNonce(null)).toBe("");
    expect(extractPayloadNonce(undefined)).toBe("");
    expect(extractPayloadNonce("nope")).toBe("");
  });
});

describe("extractPayerAddress", () => {
  it("returns authorization.from for EVM payloads", () => {
    expect(
      extractPayerAddress({
        payload: {
          signature: "0xsig",
          authorization: { from: "0xpayer" },
        },
      }),
    ).toBe("0xpayer");
  });

  it("returns payload.from for Cosmos payloads", () => {
    expect(
      extractPayerAddress({
        payload: {
          from: "noble1payer",
          authorization: { from: "noble1payer" },
        },
      }),
    ).toBe("noble1payer");
  });

  it("returns 'svm-payer' for SVM payloads (payer encoded inside tx blob)", () => {
    expect(
      extractPayerAddress({
        payload: { transaction: "AAAAAAAA" },
      }),
    ).toBe("svm-payer");
  });

  it("returns 'unknown' for unrecognized shapes", () => {
    expect(extractPayerAddress({})).toBe("unknown");
    expect(extractPayerAddress({ payload: {} })).toBe("unknown");
  });
});
