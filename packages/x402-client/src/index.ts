/**
 * Public surface of `@suverselabs/x402-client`. The root entry
 * exposes the high-level `SuverseClient`; lower-level signers live
 * behind subpath imports (`./evm`, `./solana`, `./cosmos`, `./tron`)
 * so consumers who only need one family don't pull in the others.
 */

export { SuverseClient } from "./client.js";
export type { SuverseClientOptions } from "./client.js";

export type {
  ChallengeBody,
  ResourceInfo,
  AcceptedRequirement,
  PaymentEnvelope,
  PaymentReceipt,
  FetchResult,
  MultiChainWallets,
  EvmWallet,
  EvmAccount,
  SolanaWallet,
  CosmosWallet,
  TronWallet,
  Preferences,
} from "./types.js";

export {
  X402ClientError,
  NoSupportedNetworkError,
  InsufficientAmountError,
  FacilitatorRejectedError,
} from "./types.js";

export { DEFAULT_FACILITATOR_URL } from "./facilitator/suverse.js";

export {
  CHAINS,
  lookupByCaip2,
  lookupByChainId,
  chainIdFromCaip2,
  isSupportedEvmCaip2,
} from "./network/chains.js";
export type { ChainEntry } from "./network/chains.js";

export {
  SOLANA_MAINNET,
  SOLANA_DEVNET,
  SUPPORTED_SOLANA_NETWORKS,
  SOLANA_TOKENS,
  isSupportedSolanaNetwork,
  lookupToken,
} from "./network/solana-networks.js";
export type {
  SolanaNetwork,
  SolanaToken,
} from "./network/solana-networks.js";

export {
  COSMOS_NOBLE_MAINNET,
  COSMOS_NOBLE_TESTNET,
  COSMOS_NETWORKS,
  lookupCosmosNetwork,
  isSupportedCosmosNetwork,
} from "./network/cosmos-networks.js";
export type { CosmosNetwork } from "./network/cosmos-networks.js";

export {
  TRON_MAINNET,
  TRON_NILE,
  TRON_TOKENS,
  GASFREE_MIN_USDT_ATOMIC,
  isSupportedTronNetwork,
  lookupTronToken,
} from "./network/tron-networks.js";
export type {
  TronNetwork,
  TronToken,
} from "./network/tron-networks.js";
