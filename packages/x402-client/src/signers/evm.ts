/**
 * EVM signer — single class for ALL supported `eip155:*` chains.
 *
 * One private key (or viem `LocalAccount`) covers every chain in
 * `CHAINS` where `eip3009Supported === true`. The on-the-wire EIP-712
 * signature is `transferWithAuthorization` per EIP-3009; the domain
 * is keyed by `(chainId, USDC contract address)` and the buyer never
 * has to think about it.
 */

import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import {
  CHAINS,
  chainIdFromCaip2,
  lookupByCaip2,
  type ChainEntry,
} from "../network/chains.js";
import {
  X402ClientError,
  type AcceptedRequirement,
  type EvmAccount,
  type EvmWallet,
  type PaymentEnvelope,
} from "../types.js";

/** EIP-3009 scheme advertised on the wire (x402 v2). */
export const EVM_SCHEME = "exact" as const;

/**
 * EIP-3009 EIP-712 type definition. Field order is fixed by EIP-3009
 * — do not reorder; the type hash depends on lexical order.
 */
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const PRIMARY_TYPE = "TransferWithAuthorization" as const;

/**
 * Buyer-side wire shape of the `payload` field inside a v2
 * PaymentEnvelope when scheme = "exact" on an EVM chain. Field names
 * match what the cosmos-pay / suverse-pay facilitators forward to
 * downstream adapters.
 */
export interface ExactEvmSignedPayload {
  readonly signature: `0x${string}`;
  readonly authorization: {
    readonly from: `0x${string}`;
    readonly to: `0x${string}`;
    /** uint256 atomic units — decimal string. */
    readonly value: string;
    /** Unix seconds (inclusive). */
    readonly validAfter: string;
    /** Unix seconds (exclusive). */
    readonly validBefore: string;
    /** 32-byte hex nonce, `0x` prefixed. */
    readonly nonce: `0x${string}`;
  };
}

export interface EvmSignerOptions {
  /** Hex private key OR viem `LocalAccount`. */
  readonly wallet: EvmWallet;
  /**
   * How long the signed authorization stays valid, in seconds.
   * Default 60. Must not exceed the seller's
   * `requirement.maxTimeoutSeconds`.
   */
  readonly validitySeconds?: number;
}

export interface EvmSignParams {
  readonly requirement: AcceptedRequirement;
  /** Test-only — override `now` (seconds). */
  readonly nowOverride?: number;
  /** Test-only — pin the 32-byte nonce for deterministic tests. */
  readonly nonceOverride?: `0x${string}`;
}

export class EvmSigner {
  private readonly account: EvmAccount;
  private readonly validitySeconds: number;

  constructor(options: EvmSignerOptions) {
    this.account = resolveAccount(options.wallet);
    this.validitySeconds = options.validitySeconds ?? 60;
    if (this.validitySeconds <= 0) {
      throw new X402ClientError(
        "invalid_validity",
        "validitySeconds must be positive",
      );
    }
  }

  /** Address this signer signs with. Useful for `from`-side diagnostics. */
  get address(): `0x${string}` {
    return this.account.address;
  }

  /** Networks this signer can sign for, derived from the chain registry. */
  static supportedNetworks(): readonly string[] {
    return CHAINS.filter((c) => c.eip3009Supported).map((c) => c.caip2);
  }

  /**
   * Sign a single `AcceptedRequirement` from the seller's 402 challenge.
   * Returns a full v2 `PaymentEnvelope` ready to base64-encode onto
   * the `PAYMENT-SIGNATURE` header.
   */
  async sign(params: EvmSignParams): Promise<PaymentEnvelope> {
    const { requirement } = params;
    if (requirement.scheme !== EVM_SCHEME) {
      throw new X402ClientError(
        "scheme_mismatch",
        `EvmSigner only supports scheme "${EVM_SCHEME}"; got "${requirement.scheme}"`,
      );
    }
    const chain = resolveChain(requirement);
    if (!chain.eip3009Supported) {
      throw new X402ClientError(
        "chain_not_eip3009",
        chain.skipReason ??
          `${chain.displayName} (${chain.caip2}) does not support EIP-3009 transferWithAuthorization`,
      );
    }
    if (
      requirement.asset.toLowerCase() !== chain.usdc.address.toLowerCase()
    ) {
      throw new X402ClientError(
        "asset_mismatch",
        `requirement.asset ${requirement.asset} does not match trusted USDC ${chain.usdc.address} on ${chain.displayName}`,
      );
    }

    // Defence-in-depth: if the seller's extra carries an EIP-712
    // domain, it MUST agree with our trusted local value. A
    // mismatched extra is a red flag — the seller may be trying to
    // coax a signature for a different token.
    const extra = requirement.extra ?? {};
    const extraName = typeof extra["name"] === "string" ? extra["name"] : null;
    const extraVersion =
      typeof extra["version"] === "string" ? extra["version"] : null;
    if (extraName !== null && extraName !== chain.usdc.eip712Name) {
      throw new X402ClientError(
        "domain_mismatch",
        `requirement.extra.name "${extraName}" disagrees with trusted "${chain.usdc.eip712Name}" on ${chain.displayName}`,
      );
    }
    if (extraVersion !== null && extraVersion !== chain.usdc.eip712Version) {
      throw new X402ClientError(
        "domain_mismatch",
        `requirement.extra.version "${extraVersion}" disagrees with trusted "${chain.usdc.eip712Version}" on ${chain.displayName}`,
      );
    }

    // Validity window — clamp to seller's maxTimeoutSeconds.
    const effectiveValidity = Math.min(
      this.validitySeconds,
      requirement.maxTimeoutSeconds,
    );
    const now = params.nowOverride ?? Math.floor(Date.now() / 1000);
    const validAfter = now - 2; // 2s safety margin for clock skew
    const validBefore = validAfter + effectiveValidity;

    const authorization = {
      from: this.account.address,
      to: requirement.payTo as `0x${string}`,
      value: requirement.amount,
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce: params.nonceOverride ?? freshNonce(),
    };

    const signature = await this.account.signTypedData({
      domain: {
        name: chain.usdc.eip712Name,
        version: chain.usdc.eip712Version,
        chainId: chain.chainId,
        verifyingContract: chain.usdc.address,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES as unknown as Record<
        string,
        unknown
      >,
      primaryType: PRIMARY_TYPE,
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    });

    const payload: ExactEvmSignedPayload = {
      signature,
      authorization,
    };

    return {
      x402Version: 2,
      scheme: EVM_SCHEME,
      network: requirement.network,
      accepted: requirement,
      payload: payload as unknown as Record<string, unknown>,
    };
  }
}

// ---------------------------------------------------------------
// Wire-encode helper
// ---------------------------------------------------------------

/**
 * base64-encode a `PaymentEnvelope` for the
 * `PAYMENT-SIGNATURE` / `X-PAYMENT` HTTP header. Standard base64,
 * NOT URL-safe — matches the x402 v2 spec wire encoding.
 */
export function toHeaderValue(envelope: PaymentEnvelope): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

// ---------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------

function freshNonce(): `0x${string}` {
  return ("0x" + randomBytes(32).toString("hex")) as `0x${string}`;
}

/** Normalise hex private key OR viem account into a viem-style account. */
function resolveAccount(wallet: EvmWallet): EvmAccount {
  if (typeof wallet === "string") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(wallet)) {
      throw new X402ClientError(
        "invalid_wallet",
        "EVM wallet must be 0x + 64 hex chars (32-byte private key) or a viem LocalAccount",
      );
    }
    return privateKeyToAccount(wallet) as unknown as EvmAccount;
  }
  if (
    wallet === null ||
    typeof wallet !== "object" ||
    typeof wallet.address !== "string" ||
    typeof wallet.signTypedData !== "function"
  ) {
    throw new X402ClientError(
      "invalid_wallet",
      "EVM wallet must be a 0x-prefixed private key string or a viem-shaped account with .address + .signTypedData",
    );
  }
  return wallet;
}

function resolveChain(requirement: AcceptedRequirement): ChainEntry {
  const found = lookupByCaip2(requirement.network);
  if (found) return found;
  const chainId = chainIdFromCaip2(requirement.network);
  if (chainId === null) {
    throw new X402ClientError(
      "not_evm_network",
      `network ${requirement.network} is not an eip155:* identifier; EvmSigner only handles EVM chains`,
    );
  }
  throw new X402ClientError(
    "unsupported_chain",
    `chain id ${chainId} not in @suverselabs/x402-client's chain registry. Open an issue at https://github.com/sudzikcoin/suverse-pay/issues or pin a release with that chain added.`,
  );
}
