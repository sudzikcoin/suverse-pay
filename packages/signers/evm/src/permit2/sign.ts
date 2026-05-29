import { randomBytes } from "node:crypto";
import { deriveEvmAccount } from "../derive.js";
import { chainIdFromNetwork } from "../domains.js";
import { getUsdtToken, isPermit2Token } from "../usdt-tokens.js";
import {
  buildPermit2Domain,
  isPermit2ChainId,
  PERMIT2_CONTRACT_ADDRESS,
  PERMIT2_DEPLOYED_CHAIN_IDS,
  X402_EXACT_PERMIT2_PROXY_ADDRESS,
} from "./domain.js";
import {
  buildPermit2Message,
  PERMIT2_PRIMARY_TYPE,
  PERMIT2_TYPES,
} from "./eip712.js";
import type {
  ExactPermit2Payload,
  Permit2Authorization,
  Permit2Witness,
} from "./types.js";

export interface SignPermit2Params {
  /** 12 or 24 BIP-39 words OR 0x-prefixed 32-byte hex private key. */
  secret: string;
  /** CAIP-2 EVM network e.g. "eip155:1". */
  network: string;
  /** ERC-20 token address being spent (USDT, USDC, etc.). */
  token: `0x${string}`;
  /** Atomic-unit amount the user authorizes (uint256 decimal string). */
  amount: string;
  /** Recipient address (witness.to). MUST match PaymentRequirements.payTo. */
  payTo: `0x${string}`;
  /**
   * Validity window in seconds. validAfter = now - 2; deadline =
   * validAfter + validitySeconds. Default 60. Bounded by spec's
   * `maxTimeoutSeconds` at the requirements layer; this function
   * leaves enforcement to the caller because Permit2 doesn't expose
   * a per-payment requirements struct the way EIP-3009 does.
   */
  validitySeconds?: number;
  /** Test-only override (unix seconds). */
  now?: number;
  /** Test-only override (uint256 decimal string). */
  nonce?: string;
}

export interface SignedPermit2Request {
  /** The signature + authorization payload. Goes into `paymentPayload.payload`. */
  payload: ExactPermit2Payload;
  /** Permit2 contract address used (for diagnostics + on-chain wiring). */
  permit2Contract: `0x${string}`;
}

/**
 * Generate a fresh Permit2 nonce. Permit2 stores nonces as a bitmap
 * (word index = nonce >> 8, bit position = nonce & 0xff), so the
 * search space is the full uint256 range. A random 256-bit value
 * collides with overwhelming improbability — the chance of two
 * fresh nonces hitting the same (word, bit) is ~2^-256.
 */
function freshPermit2Nonce(): string {
  const buf = randomBytes(32);
  return BigInt("0x" + buf.toString("hex")).toString();
}

/**
 * Sign an x402 Permit2 PermitWitnessTransferFrom authorization for
 * `amount` of `token` to `payTo`. Phase 4 Block 2 Sub-task 6.
 *
 * The result is the inner `payload` object the x402 client puts in
 * `paymentPayload.payload`. The outer PaymentPayload wrapping
 * (x402Version, scheme, network, ...) is the caller's responsibility
 * — Permit2 may appear inside an "exact" scheme alongside
 * `extra.assetTransferMethod: "permit2"`, but it might also be used
 * by extensions we haven't shipped yet, so this signer stays scoped
 * to the inner payload.
 *
 * Throws on any input the signer cannot fulfill safely:
 *   - network not EVM CAIP-2
 *   - chain has no Permit2 deployment
 *   - token unknown to our trusted USDT/Permit2 registry on this chain
 *   - validitySeconds non-positive
 *   - malformed secret
 *
 * The signature recovers to the derived account's address via
 * `recoverTypedDataAddress` — the round-trip test covers every
 * Permit2-supported chain.
 */
export async function signPermit2Authorization(
  params: SignPermit2Params,
): Promise<SignedPermit2Request> {
  const { secret, network, token, amount, payTo, validitySeconds = 60 } = params;

  if (validitySeconds <= 0) {
    throw new Error("validitySeconds must be positive");
  }

  const chainId = chainIdFromNetwork(network);
  if (!isPermit2ChainId(chainId)) {
    throw new Error(
      `Permit2 is not deployed on chain ${chainId}; supported: ${PERMIT2_DEPLOYED_CHAIN_IDS.join(", ")}`,
    );
  }

  // The token doesn't need to be EIP-3009 or EIP-2612 compatible for
  // Permit2 — Permit2 itself holds the user's approval. But we still
  // gate signing on a known token entry so the signer can't be coaxed
  // into authorizing a malicious token contract masquerading as USDC/
  // USDT on a chain where we haven't catalogued the deployment.
  if (!isPermit2Token(chainId, token)) {
    throw new Error(
      `no trusted Permit2 token entry for ${token} on chain ${chainId}; add it to usdt-tokens.ts`,
    );
  }

  const account = deriveEvmAccount(secret);
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const validAfter = now - 2;
  const deadline = validAfter + validitySeconds;

  const witness: Permit2Witness = {
    to: payTo,
    validAfter: validAfter.toString(),
  };

  const authorization: Permit2Authorization = {
    permitted: { token, amount },
    from: account.address,
    spender: X402_EXACT_PERMIT2_PROXY_ADDRESS,
    nonce: params.nonce ?? freshPermit2Nonce(),
    deadline: deadline.toString(),
    witness,
  };

  const signature = await account.signTypedData({
    domain: buildPermit2Domain(chainId),
    types: PERMIT2_TYPES,
    primaryType: PERMIT2_PRIMARY_TYPE,
    message: buildPermit2Message(authorization),
  });

  return {
    payload: { signature, permit2Authorization: authorization },
    permit2Contract: PERMIT2_CONTRACT_ADDRESS,
  };
}

/**
 * Convenience helper for USDT specifically — looks up the token
 * address from the registry given the network and signs.
 */
export async function signPermit2UsdtAuthorization(
  params: Omit<SignPermit2Params, "token"> & { network: string },
): Promise<SignedPermit2Request> {
  const chainId = chainIdFromNetwork(params.network);
  const entry = getUsdtToken(chainId);
  if (!entry) {
    throw new Error(`no USDT contract registered for chain ${chainId}`);
  }
  return signPermit2Authorization({
    ...params,
    token: entry.address,
  });
}
