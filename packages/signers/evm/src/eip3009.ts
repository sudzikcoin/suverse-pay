import type { EvmTokenDomain } from "./domains.js";
import type { EvmAuthorization } from "./types.js";

/**
 * EIP-712 typed data definition for EIP-3009
 * `transferWithAuthorization`. Field types and order are fixed by the
 * EIP-3009 standard — do not reorder; the EIP-712 type hash depends on
 * lexical order being exactly this.
 */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const PRIMARY_TYPE = "TransferWithAuthorization" as const;

/**
 * Build the viem-compatible `domain` object from a trusted token
 * domain. viem expects bigint or number for chainId; number is fine
 * for chain ids that fit in a JS safe integer (all our supported
 * ones do).
 */
export function buildDomain(domain: EvmTokenDomain) {
  return {
    name: domain.name,
    version: domain.version,
    chainId: domain.chainId,
    verifyingContract: domain.verifyingContract,
  };
}

/**
 * Build the viem `message` object from an EvmAuthorization. viem's
 * EIP-712 typed data signer expects bigint/uint256 fields as bigint
 * (not string). We accept the wire-format string and parse here so
 * callers don't have to think about it.
 */
export function buildMessage(auth: EvmAuthorization) {
  return {
    from: auth.from,
    to: auth.to,
    value: BigInt(auth.value),
    validAfter: BigInt(auth.validAfter),
    validBefore: BigInt(auth.validBefore),
    nonce: auth.nonce,
  };
}
