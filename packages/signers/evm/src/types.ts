// TS mirror of the x402 EVM "exact" scheme (EIP-3009
// transferWithAuthorization path). Field names use the canonical
// camelCase from the x402 spec.

export const SCHEME = "exact";

/**
 * The struct that gets EIP-712 typed-data signed by the payer.
 * Field types in JSON are decimal strings (for uint256) and hex
 * (for bytes32 nonce), matching how the x402 wire format encodes them.
 */
export interface EvmAuthorization {
  from: `0x${string}`;
  to: `0x${string}`;
  /** uint256 atomic units, decimal string. */
  value: string;
  /** uint256 unix seconds, decimal string. */
  validAfter: string;
  /** uint256 unix seconds, decimal string. */
  validBefore: string;
  /** bytes32, 0x-prefixed 32-byte hex. */
  nonce: `0x${string}`;
}

/** Inner payload for the "exact" scheme on EVM. */
export interface ExactEIP3009Payload {
  /** 65-byte ECDSA signature, 0x-prefixed hex (132 chars + "0x" = 134). */
  signature: `0x${string}`;
  authorization: EvmAuthorization;
}

/** Wire-format PaymentPayload as sent to a facilitator. */
export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string; // CAIP-2 e.g. "eip155:8453"
  payload: ExactEIP3009Payload;
}

/**
 * EVM PaymentRequirements. The `asset` field is the ERC-20 contract
 * address; `extra.name` and `extra.version` are the EIP-712 domain
 * components the token's contract uses. We validate them against a
 * local trusted domain table so a malicious resource server cannot
 * trick the signer into producing a signature for a different domain.
 */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  /** ERC-20 contract address (the verifyingContract for EIP-712). */
  asset: `0x${string}`;
  payTo: `0x${string}`;
  resource: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds: number;
  outputSchema?: Record<string, unknown>;
  extra: {
    name: string;
    version: string;
    decimals?: number;
    symbol?: string;
  };
}

/** Body for POST /verify and /settle. */
export interface SignedRequest {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}
