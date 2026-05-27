import { Secp256k1, Sha256 } from "@cosmjs/crypto";
import { toBase64 } from "@cosmjs/encoding";
import { randomBytes } from "node:crypto";
import { adr036Preimage } from "./adr036.js";
import { deriveCosmosKey } from "./derive.js";
import {
  type Authorization,
  type PaymentPayload,
  type PaymentRequirements,
  type SignedRequest,
  SCHEME,
} from "./types.js";

export interface SignParams {
  /** 12 or 24 BIP-39 words. */
  mnemonic: string;
  /** CAIP-2 network identifier, e.g. "cosmos:grand-1". */
  network: string;
  /** PaymentRequirements as advertised by the resource server. */
  requirements: PaymentRequirements;
  /** Atomic-unit amount, e.g. "10000" for 0.01 USDC (6 decimals). */
  amount: string;
  /**
   * Window size in seconds. validAfter = now - 2, validBefore =
   * validAfter + validitySeconds. Must stay <=
   * requirements.maxTimeoutSeconds or the facilitator's verify step
   * will reject with invalid_authorization. Default 50.
   */
  validitySeconds?: number;
  /**
   * Override the "now" timestamp (seconds since epoch). Test-only;
   * production callers leave undefined.
   */
  now?: number;
  /** Override the random nonce. Test-only; production leaves undefined. */
  nonce?: string;
}

/**
 * Phase 2 supports only the Noble testnet. Mainnet (cosmos:noble-1) is
 * intentionally absent — we have no funded mainnet facilitator. The
 * MCP server enforces the same list in apps/mcp/src/networks.ts; this
 * package mirrors that constraint to fail closed if called directly.
 */
const NETWORK_PREFIX: Record<string, string> = {
  "cosmos:grand-1": "noble",
};

function bech32PrefixFor(network: string): string {
  const prefix = NETWORK_PREFIX[network];
  if (!prefix) {
    throw new Error(
      `unsupported network ${network}; supported: ${Object.keys(NETWORK_PREFIX).join(", ")}`,
    );
  }
  return prefix;
}

function chainIdFromNetwork(network: string): string {
  if (!network.startsWith("cosmos:")) {
    throw new Error(`network ${network} is not a Cosmos network`);
  }
  return network.slice("cosmos:".length);
}

function freshNonce(): string {
  // 32 random bytes, 0x-prefixed hex (66 chars total) — matches Go's
  // tools/fixture freshNonce().
  const buf = randomBytes(32);
  return "0x" + buf.toString("hex");
}

/**
 * Produce a {paymentPayload, paymentRequirements} pair ready to POST to
 * a gateway's /verify or /settle. The payload's signature is an ADR-036
 * signature over the canonical Authorization JSON, byte-compatible with
 * x402-cosmos/tools/fixture's output.
 */
export async function signPaymentPayload(params: SignParams): Promise<SignedRequest> {
  const {
    mnemonic,
    network,
    requirements,
    amount,
    validitySeconds = 50,
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
      `requirements.scheme must be ${SCHEME}, got ${requirements.scheme}`,
    );
  }
  if (requirements.network !== network) {
    throw new Error(
      `network ${network} does not match requirements.network ${requirements.network}`,
    );
  }

  const prefix = bech32PrefixFor(network);
  const chainId = chainIdFromNetwork(network);
  if (requirements.extra.chainId !== chainId) {
    throw new Error(
      `requirements.extra.chainId ${requirements.extra.chainId} does not match network ${chainId}`,
    );
  }

  const { privkey, pubkeyCompressed, address } = await deriveCosmosKey(
    mnemonic,
    prefix,
  );

  const now = nowOverride ?? Math.floor(Date.now() / 1000);
  const validAfter = now - 2;
  const validBefore = validAfter + validitySeconds;

  const auth: Authorization = {
    from: address,
    to: requirements.payTo,
    denom: requirements.asset,
    amount,
    nonce: nonceOverride ?? freshNonce(),
    validAfter,
    validBefore,
    resource: requirements.resource,
    chainId,
  };

  const preimage = adr036Preimage(auth, address);
  // cosmos-sdk's secp256k1.PrivKey.Sign hashes its input with SHA-256
  // before signing. @cosmjs's Secp256k1.createSignature expects the
  // already-hashed digest, so we hash here.
  const digest = new Sha256(preimage).digest();
  const extSig = await Secp256k1.createSignature(digest, privkey);
  // Strip the trailing recovery byte: Cosmos verifiers expect r||s only,
  // 64 bytes total.
  const r = extSig.r(32);
  const s = extSig.s(32);
  const signature = new Uint8Array(64);
  signature.set(r, 0);
  signature.set(s, 32);

  const paymentPayload: PaymentPayload = {
    x402Version: 2,
    scheme: SCHEME,
    network,
    payload: {
      from: address,
      publicKey: toBase64(pubkeyCompressed),
      signature: toBase64(signature),
      authorization: auth,
    },
  };

  return { paymentPayload, paymentRequirements: requirements };
}
