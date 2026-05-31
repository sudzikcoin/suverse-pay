import { createHash } from "node:crypto";

/**
 * Derive a deterministic Idempotency-Key for /facilitator/settle.
 *
 * The key MUST include `resourceKeyId` so two unrelated resource
 * servers settling structurally similar payments (same network/asset/
 * payer/nonce) get DIFFERENT idempotency keys — otherwise one
 * resource server's settle could shadow another's. Each tenant lives
 * in its own idempotency namespace.
 *
 * Inputs:
 *   - resourceKeyId — distinguishes tenants
 *   - payerAddress  — fingerprint of "who is paying"
 *   - payloadNonce  — the per-payment nonce (EVM EIP-3009 nonce hex,
 *                     Cosmos ADR-036 nonce hex, or for SVM a sha256
 *                     of the full base64 transaction blob — see
 *                     `extractPayloadNonce` for why a prefix slice
 *                     is unsafe)
 *   - hourBucket    — floor(now / 3_600_000), so an honest retry an
 *                     hour later mints a fresh idempotency record
 *                     instead of being shadowed by an old failure
 *
 * Output: first 16 bytes of sha256 hex-encoded (32 chars).
 *
 * Property tested in idempotency-key.test.ts: same inputs → same key;
 * any input change → different key.
 */
export function deriveFacilitatorIdempotencyKey(args: {
  resourceKeyId: string;
  payerAddress: string;
  payloadNonce: string;
  now: number;
}): string {
  const hourBucket = Math.floor(args.now / 3_600_000).toString();
  const preimage = [
    args.resourceKeyId,
    args.payerAddress,
    args.payloadNonce,
    hourBucket,
  ].join("|");
  return createHash("sha256").update(preimage, "utf8").digest("hex").slice(0, 32);
}

/**
 * Pull a "payload nonce" out of a PaymentPayload, regardless of
 * whether it's an EVM (signature + authorization.nonce), Cosmos
 * (ADR-036 authorization.nonce hex), or SVM (base64 transaction
 * blob) payload.
 *
 * The contract is "a stable per-payment fingerprint", not "the
 * exact nonce field" — for SVM we use the first 32 chars of the
 * transaction base64 because the SPL TransferChecked + Memo
 * instructions plus the random Memo nonce make those bytes unique
 * per signing.
 */
export function extractPayloadNonce(paymentPayload: unknown): string {
  if (paymentPayload === null || typeof paymentPayload !== "object") return "";
  const pp = paymentPayload as Record<string, unknown>;
  const inner = pp.payload;
  if (inner === null || typeof inner !== "object") return "";
  const innerObj = inner as Record<string, unknown>;

  // EVM exact / Cosmos exact_cosmos_authz: `authorization.nonce`.
  const auth = innerObj.authorization;
  if (auth !== null && typeof auth === "object") {
    const a = auth as Record<string, unknown>;
    if (typeof a.nonce === "string" && a.nonce.length > 0) return a.nonce;
  }
  // SVM exact: the base64-encoded transaction. Hash the whole blob —
  // a prefix slice is unsafe because Solana's wire format starts with
  // a u16 sig-count + N×64-byte signature slots, and the SDK only
  // fills the buyer's slot (the facilitator co-signs the feePayer
  // slot later). So the leading ~88 chars of the base64 are
  // dominated by the zero feePayer-signature placeholder and are
  // identical across distinct signings — collapsing all of one
  // payer's settles in one hour-bucket onto one idempotency row.
  // sha256-of-full-blob keeps memo + buyer-signature entropy in.
  if (typeof innerObj.transaction === "string" && innerObj.transaction.length > 0) {
    return createHash("sha256")
      .update(innerObj.transaction, "utf8")
      .digest("hex")
      .slice(0, 32);
  }
  return "";
}

/**
 * Best-effort extraction of the payer address from a PaymentPayload.
 * Falls back to "unknown" so the derived key stays stable even when
 * we don't recognize the payload shape.
 */
export function extractPayerAddress(paymentPayload: unknown): string {
  if (paymentPayload === null || typeof paymentPayload !== "object") return "unknown";
  const pp = paymentPayload as Record<string, unknown>;
  const inner = pp.payload;
  if (inner === null || typeof inner !== "object") return "unknown";
  const innerObj = inner as Record<string, unknown>;

  // EVM: authorization.from. Cosmos: payload.from (same key).
  if (typeof innerObj.from === "string") return innerObj.from;
  const auth = innerObj.authorization;
  if (auth !== null && typeof auth === "object") {
    const a = auth as Record<string, unknown>;
    if (typeof a.from === "string") return a.from;
  }
  // SVM: no `from` field. The payer is encoded inside the transaction
  // but extracting it client-side requires deserializing the tx; for
  // idempotency-key purposes the transaction blob already covers
  // payer identity, so "svm" is a fine constant tag.
  if (typeof innerObj.transaction === "string") return "svm-payer";
  return "unknown";
}
