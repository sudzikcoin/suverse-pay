import type { Permit2Authorization } from "./types.js";

/**
 * EIP-712 typed-data definition for `PermitWitnessTransferFrom` as
 * called by the x402ExactPermit2Proxy via Permit2's `permitWitnessTransferFrom`.
 *
 * Type-string order must match the spec verbatim — viem hashes the
 * struct in declaration order:
 *
 *   PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)
 *   TokenPermissions(address token,uint256 amount)
 *   Witness(address to,uint256 validAfter)
 *
 * Mismatch produces a signature that the on-chain verifier rejects;
 * round-trip recovery via viem's recoverTypedDataAddress catches it
 * at test time.
 */
export const PERMIT2_PRIMARY_TYPE = "PermitWitnessTransferFrom" as const;

export const PERMIT2_TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
} as const;

/**
 * Build the viem `message` object from a Permit2Authorization. Wire
 * format carries uint256 fields as decimal strings; viem expects
 * bigint. Conversion happens here so callers stay on the string side
 * of the boundary.
 */
export function buildPermit2Message(auth: Permit2Authorization) {
  return {
    permitted: {
      token: auth.permitted.token,
      amount: BigInt(auth.permitted.amount),
    },
    spender: auth.spender,
    nonce: BigInt(auth.nonce),
    deadline: BigInt(auth.deadline),
    witness: {
      to: auth.witness.to,
      validAfter: BigInt(auth.witness.validAfter),
    },
  };
}
