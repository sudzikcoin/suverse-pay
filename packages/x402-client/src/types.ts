/**
 * Buyer-side types for `@suverselabs/x402-client`.
 *
 * The wire format mirrors x402 v2 as advertised by the suverse-pay
 * facilitator (Coinbase-flavour, see
 * `@x402/core@2.14+ PaymentRequiredV2Schema`). Where x402 v2 and
 * legacy v1 differ in the challenge body, the client accepts either
 * shape but emits v2 outbound payloads only.
 */

// ---------------------------------------------------------------
// 402 challenge body — what the seller's middleware emits
// ---------------------------------------------------------------

/**
 * v2 challenge body. Top-level `resource` is structured (NOT a
 * per-accept string the way v1 had it); each entry in `accepts`
 * uses `amount` (NOT `maxAmountRequired`) and adds
 * `maxTimeoutSeconds`. Compatible v1 shape is normalised at parse
 * time.
 */
export interface ChallengeBody {
  readonly x402Version: 1 | 2;
  /**
   * Resource the buyer is paying for. v1 had this as a per-accept
   * string; v2 is a structured top-level object. The client always
   * normalises to v2 form on parse.
   */
  readonly resource: ResourceInfo;
  /** Public description shown by agent UIs. Optional. */
  readonly description?: string;
  /** Seller-accepted payment options — non-empty after parse. */
  readonly accepts: readonly AcceptedRequirement[];
  /** Optional error hint from the seller (e.g. "bad_sig"). */
  readonly error?: string;
}

export interface ResourceInfo {
  readonly url: string;
  readonly description?: string;
  readonly mimeType?: string;
}

/**
 * One entry in `challenge.accepts`. Anything the buyer needs to
 * produce a signed payment for THIS chain lives here. Per-chain
 * `extra` carries chain-specific data (EVM EIP-712 domain
 * `{ name, version }` for example).
 */
export interface AcceptedRequirement {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  /** Atomic units — uint256-safe string. */
  readonly amount: string;
  readonly maxTimeoutSeconds: number;
  readonly description?: string;
  readonly extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------
// Outbound payment payload — what the buyer signs
// ---------------------------------------------------------------

/**
 * Top-level wrapper for the base64 JSON shipped on the
 * `PAYMENT-SIGNATURE` / `X-PAYMENT` header.
 */
export interface PaymentEnvelope {
  readonly x402Version: 2;
  /**
   * The accepted requirement the buyer is paying against, embedded
   * verbatim. v2 servers read scheme + network from here.
   */
  readonly accepted: AcceptedRequirement;
  /**
   * Chain-specific signed payload. Shape varies per scheme — see the
   * matching `SignedPayload*` interfaces in each signer.
   */
  readonly payload: Record<string, unknown>;
  /** Convenience top-level scheme + network for legacy v1 servers. */
  readonly scheme: string;
  readonly network: string;
}

// ---------------------------------------------------------------
// Wallets the client signs with
// ---------------------------------------------------------------

/**
 * Wallets the user provides at SuverseClient construction time.
 * Every field is optional — the client only signs on chains it has a
 * wallet for. If the seller's challenge advertises only chains the
 * user has no wallet for, the call fails with `NoSupportedNetworkError`.
 */
export interface MultiChainWallets {
  /**
   * Hex private key (`0x` + 64 hex) OR a viem `LocalAccount` instance.
   * Works for every supported EIP-3009 chain — one key spans all 18
   * mainnets.
   */
  readonly evm?: EvmWallet;
  /** Solana — base58 secret key OR Uint8Array seed. Phase 3. */
  readonly solana?: SolanaWallet;
  /** Cosmos — 12 or 24-word BIP-39 mnemonic. Phase 4. */
  readonly cosmos?: CosmosWallet;
  /** TRON — hex private key. Phase 5. */
  readonly tron?: TronWallet;
}

export type EvmWallet = `0x${string}` | EvmAccount;

/**
 * Viem `LocalAccount` (intentionally NOT typed as `import("viem")`
 * here so consumers without viem in their dep tree can still hold a
 * reference). Cast required when constructing in TypeScript.
 */
export interface EvmAccount {
  readonly address: `0x${string}`;
  signTypedData(args: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

export type SolanaWallet = string | Uint8Array;
export type CosmosWallet = string;
export type TronWallet = string;

// ---------------------------------------------------------------
// Receipts + responses
// ---------------------------------------------------------------

/**
 * What client.fetch() resolves to on success.
 */
export interface FetchResult<T = unknown> {
  /** Parsed JSON if response is JSON; raw text otherwise. */
  readonly data: T;
  /** The HTTP Response after payment retry. */
  readonly response: Response;
  /** Receipt extracted from PAYMENT-RESPONSE / X-PAYMENT-RESPONSE. */
  readonly payment: PaymentReceipt;
}

export interface PaymentReceipt {
  readonly network: string;
  readonly scheme: string;
  readonly asset: string;
  readonly amount: string;
  readonly payer: string;
  readonly payTo: string;
  /** Tx hash from the facilitator/server (null in verify-only mode). */
  readonly txHash: string | null;
}

// ---------------------------------------------------------------
// Selection + preferences
// ---------------------------------------------------------------

export interface Preferences {
  /** Try this CAIP-2 network first if the seller accepts it. */
  readonly preferredNetwork?: string;
  /** Never pay on these networks even if seller accepts them. */
  readonly avoidNetworks?: readonly string[];
  /** Hard cap — abort if best-available chain's gas estimate exceeds this. */
  readonly maxGasUsd?: number;
}

// ---------------------------------------------------------------
// Errors
// ---------------------------------------------------------------

export class X402ClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "X402ClientError";
    this.code = code;
  }
}

export class NoSupportedNetworkError extends X402ClientError {
  constructor(message: string) {
    super("no_supported_network", message);
    this.name = "NoSupportedNetworkError";
  }
}

export class InsufficientAmountError extends X402ClientError {
  constructor(message: string) {
    super("insufficient_amount", message);
    this.name = "InsufficientAmountError";
  }
}

export class FacilitatorRejectedError extends X402ClientError {
  readonly httpStatus: number;
  readonly invalidReason: string | null;
  constructor(
    httpStatus: number,
    invalidReason: string | null,
    message: string,
  ) {
    super("facilitator_rejected", message);
    this.name = "FacilitatorRejectedError";
    this.httpStatus = httpStatus;
    this.invalidReason = invalidReason;
  }
}
