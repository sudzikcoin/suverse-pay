/**
 * x402 Permit2 wire-format types. Phase 4 Block 2 Sub-task 6.
 *
 * Mirrors the spec at
 * https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md
 * — section "AssetTransferMethod: Permit2".
 *
 * The Permit2 path is selected by `scheme="exact"` + `extra.assetTransferMethod="permit2"`
 * in PaymentRequirements (NOT a new scheme name). Default fallback is
 * EIP-3009 if the token supports it.
 */

/**
 * The `permitted` block — the token + amount the user authorizes the
 * x402ExactPermit2Proxy to transfer on their behalf via the Permit2
 * `permitWitnessTransferFrom` entrypoint.
 */
export interface Permit2TokenPermissions {
  /** ERC-20 contract address (USDT, USDC, USDC-bridged, etc.). */
  token: `0x${string}`;
  /** Maximum amount authorized, atomic units, decimal string. */
  amount: string;
}

/**
 * The Witness binds the recipient address — the facilitator/proxy
 * cannot redirect funds away from `witness.to` without invalidating
 * the signature. Per spec, the Witness ONLY contains these two
 * fields (post-audit `extra` was removed).
 */
export interface Permit2Witness {
  /** Recipient address. MUST match PaymentRequirements.payTo. */
  to: `0x${string}`;
  /**
   * Unix seconds. Settlement reverts before this timestamp. The
   * x402 Permit2 path does NOT use a separate validBefore — instead
   * the `deadline` field (top-level of permit) bounds the upper end.
   */
  validAfter: string;
}

/**
 * Full Permit2 authorization payload. Matches the JSON the x402
 * client emits in `payload.permit2Authorization`.
 */
export interface Permit2Authorization {
  /** TokenPermissions block. */
  permitted: Permit2TokenPermissions;
  /** Signer / owner address (the payer). */
  from: `0x${string}`;
  /**
   * Always the canonical x402ExactPermit2Proxy address
   * (`0x402085c248EeA27D92E8b30b2C58ed07f9E20001`). The proxy
   * enforces that funds go to `witness.to`.
   */
  spender: `0x${string}`;
  /**
   * Permit2 uint256 nonce. Permit2 uses bitmap nonces internally
   * (word index + bit position) — for x402 a fresh random 256-bit
   * value is fine because the bit at `nonce >> 8`, bit `nonce & 0xff`
   * is overwhelmingly likely to be unset.
   */
  nonce: string;
  /** Unix seconds. Permit2 rejects signatures past this timestamp. */
  deadline: string;
  /** Recipient-binding witness. */
  witness: Permit2Witness;
}

/**
 * Inner shape of `paymentPayload.payload` when the Permit2 transfer
 * method is in use. Counterpart to ExactEIP3009Payload in types.ts.
 */
export interface ExactPermit2Payload {
  /** 65-byte secp256k1 signature, hex with 0x prefix. */
  signature: `0x${string}`;
  /** The Permit2Authorization the signature covers. */
  permit2Authorization: Permit2Authorization;
}
