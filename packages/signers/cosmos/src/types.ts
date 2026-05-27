// TS mirror of x402-cosmos/facilitator/types.go. Field names use the
// camelCase JSON tags as declared on the Go struct — never the Go field
// names themselves. Wire-format fidelity matters: every field name and
// type here is part of what the payer signs over via ADR-036.

export const SCHEME = "exact_cosmos_authz";

/**
 * The structured message the payer signs. Field order in the struct is
 * irrelevant — the canonical JSON serialization re-sorts keys
 * lexicographically — but JSON field names and types ARE part of the
 * wire format. Match Go's `json:` tags byte-for-byte.
 */
export interface Authorization {
  from: string;
  to: string;
  denom: string;
  amount: string; // atomic units, decimal string
  nonce: string; // 0x-prefixed hex, 32 bytes (66 chars)
  validAfter: number; // unix seconds, inclusive
  validBefore: number; // unix seconds, exclusive
  resource: string;
  chainId: string;
}

export interface RequirementsExtra {
  facilitator: string; // bech32 grantee
  chainId: string;
  decimals?: number;
  symbol?: string;
}

export interface PaymentRequirements {
  scheme: string;
  network: string; // "cosmos:<chain-id>"
  maxAmountRequired: string;
  asset: string;
  payTo: string;
  resource: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds: number;
  outputSchema?: Record<string, unknown>;
  extra: RequirementsExtra;
}

export interface CosmosPayload {
  from: string;
  publicKey: string; // base64, 33-byte compressed secp256k1
  signature: string; // base64, 64-byte r||s (NOT DER)
  authorization: Authorization;
}

export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: CosmosPayload;
}

/** Body of POST /verify and /settle on the facilitator. */
export interface SignedRequest {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

/** Response of POST /verify. */
export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}
