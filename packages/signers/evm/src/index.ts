export type {
  EvmAuthorization,
  ExactEIP3009Payload,
  PaymentPayload,
  PaymentRequirements,
  SignedRequest,
} from "./types.js";
export { SCHEME } from "./types.js";
export { signPaymentPayload, type SignParams } from "./sign.js";
export { deriveEvmAccount, type EvmAccount } from "./derive.js";
export {
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  PRIMARY_TYPE,
  buildDomain,
  buildMessage,
} from "./eip3009.js";
export {
  allDomains,
  chainIdFromNetwork,
  getDomain,
  isSupportedChainId,
  SUPPORTED_CHAIN_IDS,
  type EvmTokenDomain,
  type SupportedChainId,
} from "./domains.js";

// ---- Phase 4 Block 2 Sub-task 6 — Permit2 path (USDT support) ----
export {
  allPermit2Tokens,
  getPermit2Token,
  getUsdtToken,
  isPermit2Token,
  PERMIT2_TOKEN_CHAIN_IDS,
  type Permit2TokenEntry,
} from "./usdt-tokens.js";
export {
  buildPermit2Domain,
  isPermit2ChainId,
  isX402Permit2SettlableChainId,
  PERMIT2_CONTRACT_ADDRESS,
  PERMIT2_DEPLOYED_CHAIN_IDS,
  X402_EXACT_PERMIT2_PROXY_ADDRESS,
  X402_PERMIT2_SETTLABLE_CHAIN_IDS,
  type Permit2ChainId,
  type X402Permit2SettlableChainId,
} from "./permit2/domain.js";
export {
  buildPermit2Message,
  PERMIT2_PRIMARY_TYPE,
  PERMIT2_TYPES,
} from "./permit2/eip712.js";
export {
  signPermit2Authorization,
  signPermit2UsdtAuthorization,
  type SignedPermit2Request,
  type SignPermit2Params,
} from "./permit2/sign.js";
export type {
  ExactPermit2Payload,
  Permit2Authorization,
  Permit2TokenPermissions,
  Permit2Witness,
} from "./permit2/types.js";
