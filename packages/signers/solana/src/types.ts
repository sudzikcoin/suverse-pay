// TS mirror of the x402 SVM "exact" scheme wire format
// (specs/schemes/exact/scheme_exact_svm.md). Field names use the
// camelCase JSON the resource server / facilitator expect.

export const SCHEME = "exact";

/** Solana mainnet CAIP-2 identifier (genesis-hash form). */
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/**
 * Solana devnet CAIP-2 identifier (genesis-hash form). Used for
 * end-to-end testing against PayAI devnet (no API key, no real money).
 */
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

/** Both Solana networks the signer accepts. */
export const SUPPORTED_SOLANA_NETWORKS: readonly string[] = [
  SOLANA_MAINNET,
  SOLANA_DEVNET,
];

/**
 * Scheme-specific payload inside a PaymentPayload — for SVM exact, just
 * the base64-encoded partially-signed versioned transaction.
 */
export interface SvmPayload {
  /** base64 of a serialized, partially-signed Solana versioned transaction. */
  transaction: string;
}

/** Wire-format PaymentPayload as sent to a facilitator. */
export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: SvmPayload;
}

/**
 * SVM PaymentRequirements. `asset` is the SPL token mint address
 * (base58). `extra.feePayer` is the facilitator's pubkey — they sign
 * last and submit. `extra.memo` (optional) pins a seller-defined memo
 * string for reconciliation; otherwise the signer mints a random
 * 16-byte memo for transaction uniqueness.
 */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  /** SPL token mint (base58). */
  asset: string;
  /** Recipient owner pubkey (base58); the destination ATA is derived. */
  payTo: string;
  resource: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  extra: {
    /** Facilitator's pubkey (base58). They pay tx fees and submit. */
    feePayer: string;
    /** Optional seller-defined memo (UTF-8, ≤ 256 bytes). */
    memo?: string;
    decimals?: number;
    symbol?: string;
  };
}

/** Body for POST /verify and /settle. */
export interface SignedRequest {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}
