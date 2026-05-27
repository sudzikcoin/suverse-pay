import { randomBytes } from "node:crypto";
import {
  chainIdFromNetwork,
  getDomain,
  isSupportedChainId,
  SUPPORTED_CHAIN_IDS,
} from "./domains.js";
import { deriveEvmAccount } from "./derive.js";
import {
  buildDomain,
  buildMessage,
  PRIMARY_TYPE,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
} from "./eip3009.js";
import {
  SCHEME,
  type EvmAuthorization,
  type PaymentPayload,
  type PaymentRequirements,
  type SignedRequest,
} from "./types.js";

export interface SignParams {
  /** 12 or 24 BIP-39 words OR 0x-prefixed 32-byte hex private key. */
  secret: string;
  /** CAIP-2 EVM network e.g. "eip155:8453". */
  network: string;
  /** PaymentRequirements as advertised by the resource server. */
  requirements: PaymentRequirements;
  /** uint256 atomic units, decimal string. */
  amount: string;
  /**
   * Validity window in seconds. validAfter = now - 2, validBefore =
   * validAfter + validitySeconds. Must stay <=
   * requirements.maxTimeoutSeconds. Default 60.
   */
  validitySeconds?: number;
  /** Test-only: override `now` (seconds since epoch). */
  now?: number;
  /** Test-only: override the random 32-byte nonce. */
  nonce?: `0x${string}`;
}

function freshNonce(): `0x${string}` {
  const buf = randomBytes(32);
  return ("0x" + buf.toString("hex")) as `0x${string}`;
}

/**
 * Produce a {paymentPayload, paymentRequirements} pair for the x402
 * "exact" scheme on an EVM network. Signs an EIP-3009
 * TransferWithAuthorization with the account derived from `secret`,
 * using a trusted local domain table keyed by (chainId, asset
 * address).
 *
 * Throws on any input that the signer cannot fulfill safely:
 * unsupported network, unknown token contract on this network,
 * `requirements.extra` disagreeing with the local trusted domain,
 * validity window exceeding maxTimeoutSeconds, malformed secret.
 */
export async function signPaymentPayload(params: SignParams): Promise<SignedRequest> {
  const {
    secret,
    network,
    requirements,
    amount,
    validitySeconds = 60,
    now: nowOverride,
    nonce: nonceOverride,
  } = params;

  if (validitySeconds <= 0) {
    throw new Error("validitySeconds must be positive");
  }
  if (validitySeconds > requirements.maxTimeoutSeconds) {
    throw new Error(
      `validitySeconds (${validitySeconds}) exceeds requirements.maxTimeoutSeconds (${requirements.maxTimeoutSeconds})`,
    );
  }
  if (requirements.scheme !== SCHEME) {
    throw new Error(
      `requirements.scheme must be "${SCHEME}", got "${requirements.scheme}"`,
    );
  }
  if (requirements.network !== network) {
    throw new Error(
      `network ${network} does not match requirements.network ${requirements.network}`,
    );
  }

  const chainId = chainIdFromNetwork(network);
  if (!isSupportedChainId(chainId)) {
    throw new Error(
      `unsupported chain ${chainId}; supported: ${SUPPORTED_CHAIN_IDS.join(", ")}`,
    );
  }

  const domain = getDomain(chainId, requirements.asset);
  if (!domain) {
    throw new Error(
      `no trusted EIP-712 domain for asset ${requirements.asset} on chain ${chainId}`,
    );
  }

  // Defense-in-depth: ensure the resource server's advertised domain
  // matches our local trusted values. If they disagree the server may
  // be trying to coax a signature for a different token; refuse.
  if (requirements.extra.name !== domain.name) {
    throw new Error(
      `requirements.extra.name "${requirements.extra.name}" disagrees with trusted "${domain.name}"`,
    );
  }
  if (requirements.extra.version !== domain.version) {
    throw new Error(
      `requirements.extra.version "${requirements.extra.version}" disagrees with trusted "${domain.version}"`,
    );
  }

  const account = deriveEvmAccount(secret);
  const now = nowOverride ?? Math.floor(Date.now() / 1000);
  const validAfter = now - 2;
  const validBefore = validAfter + validitySeconds;

  const auth: EvmAuthorization = {
    from: account.address,
    to: requirements.payTo,
    value: amount,
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce: nonceOverride ?? freshNonce(),
  };

  const signature = await account.signTypedData({
    domain: buildDomain(domain),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: PRIMARY_TYPE,
    message: buildMessage(auth),
  });

  const paymentPayload: PaymentPayload = {
    x402Version: 2,
    scheme: SCHEME,
    network,
    payload: { signature, authorization: auth },
  };

  return { paymentPayload, paymentRequirements: requirements };
}
