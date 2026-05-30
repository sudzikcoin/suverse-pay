/**
 * TRON signer — `tron:mainnet` + `tron:nile` under the
 * `exact_gasfree` scheme (gasfree.io sponsored relay) in v0.1.0.
 *
 * Scheme matrix:
 *
 *   - **`exact_gasfree`** — ✅ implemented. The buyer signs a
 *     TIP-712 (EIP-712-equivalent over TRON's secp256k1) PermitTransfer
 *     authorisation that gasfree.io's relayer contract executes,
 *     paying gas on the buyer's behalf in USDT. Subject to gasfree's
 *     $1.50 USDT minimum (see `GASFREE_MIN_USDT_ATOMIC`). The exact
 *     TIP-712 domain (`name`, `version`, `verifyingContract`) is
 *     configurable per network because gasfree.io's contract addresses
 *     are not stable across mainnet vs Nile — pass via
 *     `signerOptions.tron.gasfreeDomain` when the defaults don't match.
 *
 *   - **`exact`** — ❌ NOT implemented in v0.1.0. Tether USDT on
 *     TRON does not expose EIP-3009 `transferWithAuthorization`;
 *     a working `exact` path requires a TRON-native transaction
 *     signing flow (`tronweb.trx.signTransaction`) that is not
 *     in-scope for the initial release. Throws with a clear hint.
 *
 *   - **`exact_permit`** — ❌ NOT implemented in v0.1.0. USDT-on-TRON
 *     has no EIP-2612 `permit`; the BofAI `exact_permit` route is
 *     for chains where the underlying TRC-20 implementation actually
 *     supports a permit-style signature, which is not currently the
 *     case for Tether. Throws with a clear hint.
 *
 * Because v0.1.0 only signs `exact_gasfree`, the SuverseClient's
 * routing layer filters TRON candidates down to that scheme before
 * picking. If a seller's challenge advertises only `exact` /
 * `exact_permit`, the client refuses with `NoSupportedNetworkError`
 * pointing at the gasfree path.
 *
 * ⚠️ EXPERIMENTAL — the TRON wire format is not yet end-to-end
 * verified against a real BofAI settle in this monorepo (unlike
 * EVM / Solana / Cosmos which have on-chain settle history). When
 * you go to production with TRON, smoke against
 * `https://facilitator.bankofai.io/verify` first to confirm the
 * payload shape matches what BofAI's TRON adapter actually accepts.
 */

import { randomBytes } from "node:crypto";
import bs58check from "bs58check";
import { privateKeyToAccount } from "viem/accounts";
import {
  GASFREE_MIN_USDT_ATOMIC,
  isSupportedTronNetwork,
  lookupTronToken,
  TRON_MAINNET,
  TRON_NILE,
} from "../network/tron-networks.js";
import {
  InsufficientAmountError,
  X402ClientError,
  type AcceptedRequirement,
  type EvmAccount,
  type PaymentEnvelope,
  type TronWallet,
} from "../types.js";

export const TRON_GASFREE_SCHEME = "exact_gasfree" as const;
export const TRON_EXACT_SCHEME = "exact" as const;
export const TRON_PERMIT_SCHEME = "exact_permit" as const;

/**
 * TIP-712 PermitTransfer struct. Field order is part of the type
 * hash; do not reorder.
 */
const PERMIT_TRANSFER_TYPES = {
  PermitTransfer: [
    { name: "token", type: "address" },
    { name: "user", type: "address" },
    { name: "receiver", type: "address" },
    { name: "value", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/**
 * Default gasfree.io TIP-712 domain values. **CHANGE THESE IN
 * PRODUCTION** — gasfree.io has not published a stable contract
 * address as of this release. The signer accepts a
 * `signerOptions.tron.gasfreeDomain` override on the client so you
 * can plug in the value you confirmed against the facilitator.
 *
 * `chainId` uses TRON's network ids exposed via TIP-712:
 *   - mainnet: 0x2b6653dc → 728126428
 *   - nile:    0xcd8690dc → 3448148188
 */
export interface GasfreeDomain {
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  /** Verifying contract — 0x + 40 hex (gasfree.io PermitTransfer proxy). */
  readonly verifyingContract: `0x${string}`;
}

export const DEFAULT_GASFREE_DOMAIN_MAINNET: GasfreeDomain = {
  name: "GasFree",
  version: "V1.0.0",
  chainId: 728126428,
  // PLACEHOLDER — override via signerOptions.tron.gasfreeDomain.
  verifyingContract: "0x0000000000000000000000000000000000000000",
};

export const DEFAULT_GASFREE_DOMAIN_NILE: GasfreeDomain = {
  name: "GasFree",
  version: "V1.0.0",
  chainId: 3448148188,
  // PLACEHOLDER — override via signerOptions.tron.gasfreeDomain.
  verifyingContract: "0x0000000000000000000000000000000000000000",
};

export interface TronSignerOptions {
  readonly wallet: TronWallet;
  /**
   * Override the TIP-712 domain used for `exact_gasfree` per network.
   * Required for production use — the defaults have a placeholder
   * verifying contract that gasfree.io's relayer will reject.
   */
  readonly gasfreeDomain?: {
    readonly mainnet?: GasfreeDomain;
    readonly nile?: GasfreeDomain;
  };
  /**
   * Default deadline window in seconds. `deadline = now + window`.
   * Default 60. Capped to `requirement.maxTimeoutSeconds`.
   */
  readonly validitySeconds?: number;
  /**
   * Default `maxFee` (in atomic USDT units) the buyer is willing to
   * pay the gasfree relayer. Default 100_000 (= 0.10 USDT). Capped
   * to `requirement.maxAmountRequired / 2` to prevent a malicious
   * seller from setting `value` low and `maxFee` high.
   */
  readonly defaultMaxFeeAtomic?: bigint;
}

export interface TronSignParams {
  readonly requirement: AcceptedRequirement;
  /** Test-only — pin `now`. */
  readonly nowOverride?: number;
  /** Test-only — pin nonce. */
  readonly nonceOverride?: string;
  /** Test-only — pin maxFee. */
  readonly maxFeeOverride?: bigint;
}

export class TronSigner {
  private readonly account: EvmAccount;
  private readonly domains: {
    readonly mainnet: GasfreeDomain;
    readonly nile: GasfreeDomain;
  };
  private readonly validitySeconds: number;
  private readonly defaultMaxFee: bigint;
  private readonly tronAddress: string;

  constructor(options: TronSignerOptions) {
    this.account = resolveAccount(options.wallet);
    this.tronAddress = evmHexToTron(this.account.address);
    this.domains = {
      mainnet:
        options.gasfreeDomain?.mainnet ?? DEFAULT_GASFREE_DOMAIN_MAINNET,
      nile: options.gasfreeDomain?.nile ?? DEFAULT_GASFREE_DOMAIN_NILE,
    };
    this.validitySeconds = options.validitySeconds ?? 60;
    if (this.validitySeconds <= 0) {
      throw new X402ClientError(
        "invalid_validity",
        "validitySeconds must be positive",
      );
    }
    this.defaultMaxFee = options.defaultMaxFeeAtomic ?? 100_000n;
    if (this.defaultMaxFee < 0n) {
      throw new X402ClientError(
        "invalid_max_fee",
        "defaultMaxFeeAtomic must be non-negative",
      );
    }
  }

  /** Buyer's TRON base58 address. */
  get address(): string {
    return this.tronAddress;
  }

  static supportedNetworks(): readonly string[] {
    return [TRON_MAINNET, TRON_NILE];
  }

  /** Schemes implemented in v0.1.0. */
  static supportedSchemes(): readonly string[] {
    return [TRON_GASFREE_SCHEME];
  }

  async sign(params: TronSignParams): Promise<PaymentEnvelope> {
    const { requirement } = params;
    if (!isSupportedTronNetwork(requirement.network)) {
      throw new X402ClientError(
        "unsupported_chain",
        `network ${requirement.network} is not a recognised TRON network`,
      );
    }

    if (requirement.scheme === TRON_EXACT_SCHEME) {
      throw new X402ClientError(
        "scheme_not_implemented_v0_1_0",
        "TRON `exact` scheme requires TRC-20 transaction signing (tronweb.trx.signTransaction) which is not implemented in v0.1.0. Use `exact_gasfree` (gasfree.io relay) which IS implemented, or pin a release that includes the exact path.",
      );
    }
    if (requirement.scheme === TRON_PERMIT_SCHEME) {
      throw new X402ClientError(
        "scheme_not_implemented_v0_1_0",
        "TRON `exact_permit` scheme has no working TRC-20 USDT pathway today (Tether USDT on TRON does not expose EIP-2612 permit). Use `exact_gasfree` instead.",
      );
    }
    if (requirement.scheme !== TRON_GASFREE_SCHEME) {
      throw new X402ClientError(
        "scheme_mismatch",
        `TronSigner v0.1.0 only supports "${TRON_GASFREE_SCHEME}"; got "${requirement.scheme}"`,
      );
    }

    // Gasfree minimum (USDT atomic units).
    const amount = BigInt(requirement.amount);
    if (amount < GASFREE_MIN_USDT_ATOMIC) {
      throw new InsufficientAmountError(
        `gasfree.io requires a minimum of ${GASFREE_MIN_USDT_ATOMIC} atomic USDT ($1.50); requirement asks for ${amount} (= $${(Number(amount) / 1e6).toFixed(3)}). TRON payments below this minimum cannot settle through the relayer.`,
      );
    }

    // Asset must match a known USDT mint or seller must supply
    // explicit symbol+decimals.
    const tokenInfo = lookupTronToken(requirement.network, requirement.asset);
    if (!tokenInfo) {
      throw new X402ClientError(
        "unknown_token",
        `asset ${requirement.asset} on ${requirement.network} is not in @suverselabs/x402-client's TRON token registry. v0.1.0 only knows USDT.`,
      );
    }

    const domain =
      requirement.network === TRON_MAINNET
        ? this.domains.mainnet
        : this.domains.nile;

    if (
      domain.verifyingContract.toLowerCase() ===
      "0x0000000000000000000000000000000000000000"
    ) {
      throw new X402ClientError(
        "missing_gasfree_domain",
        `default gasfree.io TIP-712 verifyingContract is a placeholder. Pass signerOptions.tron.gasfreeDomain.${requirement.network === TRON_MAINNET ? "mainnet" : "nile"} with the real contract address before signing in production. See README for the lookup path.`,
      );
    }

    const effectiveValidity = Math.min(
      this.validitySeconds,
      requirement.maxTimeoutSeconds,
    );
    const now = params.nowOverride ?? Math.floor(Date.now() / 1000);
    const deadline = now + effectiveValidity;

    const nonce = params.nonceOverride ?? freshNonceUint();
    // maxFee defence — half of value or default, whichever is less.
    const maxFee =
      params.maxFeeOverride ??
      (this.defaultMaxFee > amount / 2n
        ? amount / 2n
        : this.defaultMaxFee);

    const userEvmHex = tronToEvmHex(this.tronAddress);
    const receiverEvmHex = tronToEvmHex(requirement.payTo);
    const tokenEvmHex = tronToEvmHex(requirement.asset);

    const signature = await this.account.signTypedData({
      domain: {
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId,
        verifyingContract: domain.verifyingContract,
      },
      types: PERMIT_TRANSFER_TYPES as unknown as Record<string, unknown>,
      primaryType: "PermitTransfer",
      message: {
        token: tokenEvmHex,
        user: userEvmHex,
        receiver: receiverEvmHex,
        value: amount,
        maxFee,
        deadline: BigInt(deadline),
        nonce: BigInt(nonce),
      },
    });

    const gasfreeAuthorization = {
      token: requirement.asset,
      user: this.tronAddress,
      receiver: requirement.payTo,
      value: amount.toString(),
      maxFee: maxFee.toString(),
      deadline: deadline.toString(),
      nonce: nonce.toString(),
    };

    return {
      x402Version: 2,
      scheme: TRON_GASFREE_SCHEME,
      network: requirement.network,
      accepted: requirement,
      payload: {
        signature,
        gasfreeAuthorization,
      } as unknown as Record<string, unknown>,
    };
  }
}

// ---------------------------------------------------------------
// Wire-encode helper
// ---------------------------------------------------------------

export function toHeaderValue(envelope: PaymentEnvelope): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

// ---------------------------------------------------------------
// Address conversion: TRON base58check ↔ EVM-style 0x hex
// ---------------------------------------------------------------

const TRON_ADDRESS_PREFIX_BYTE = 0x41;

/**
 * Convert a TRON base58check address (starts with "T") into the
 * 20-byte EVM-style 0x address that TIP-712 typed-data uses.
 */
export function tronToEvmHex(addr: string): `0x${string}` {
  if (!addr.startsWith("T") || addr.length !== 34) {
    throw new X402ClientError(
      "invalid_tron_address",
      `expected TRON base58 address (starts with "T", 34 chars); got "${addr}"`,
    );
  }
  let decoded: Uint8Array;
  try {
    decoded = bs58check.decode(addr);
  } catch (err) {
    throw new X402ClientError(
      "invalid_tron_address",
      `base58check decode failed for "${addr}": ${(err as Error).message}`,
    );
  }
  if (decoded.length !== 21 || decoded[0] !== TRON_ADDRESS_PREFIX_BYTE) {
    throw new X402ClientError(
      "invalid_tron_address",
      `TRON address must decode to 21 bytes starting with 0x41; got length ${decoded.length}`,
    );
  }
  // Skip the 0x41 prefix, take the 20-byte address.
  const hex = Array.from(decoded.slice(1))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hex}` as `0x${string}`;
}

/**
 * Convert an EVM-style 0x hex address into a TRON base58 address.
 */
export function evmHexToTron(addr: `0x${string}`): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new X402ClientError(
      "invalid_evm_address",
      `expected 0x + 40 hex chars; got "${addr}"`,
    );
  }
  const bytes = new Uint8Array(21);
  bytes[0] = TRON_ADDRESS_PREFIX_BYTE;
  for (let i = 0; i < 20; i++) {
    bytes[i + 1] = parseInt(addr.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return bs58check.encode(bytes);
}

// ---------------------------------------------------------------
// Wallet resolution
// ---------------------------------------------------------------

function resolveAccount(wallet: TronWallet): EvmAccount {
  if (typeof wallet !== "string") {
    throw new X402ClientError(
      "invalid_wallet",
      "TRON wallet must be a 0x-prefixed hex string (64 hex chars) — KMS-issued private key in EVM-style hex",
    );
  }
  const normalised = wallet.startsWith("0x") ? wallet : `0x${wallet}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalised)) {
    throw new X402ClientError(
      "invalid_wallet",
      "TRON wallet must be 32 bytes (0x + 64 hex chars). Tron secp256k1 private keys are interchangeable with EVM private keys.",
    );
  }
  return privateKeyToAccount(
    normalised as `0x${string}`,
  ) as unknown as EvmAccount;
}

// ---------------------------------------------------------------
// Compat shim for client.ts (Phase 1 stub shape)
// ---------------------------------------------------------------

export async function signTronPayment(params: {
  readonly wallet: TronWallet;
  readonly requirement: AcceptedRequirement;
}): Promise<PaymentEnvelope> {
  const signer = new TronSigner({ wallet: params.wallet });
  return signer.sign({ requirement: params.requirement });
}

// ---------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------

/**
 * 64-bit random nonce as a decimal string. gasfree.io's
 * PermitTransfer.nonce is a uint256 but typical relayers de-dupe on
 * a smaller window; 64 random bits is plenty of collision space and
 * fits in a JS bigint for client-side bookkeeping.
 */
function freshNonceUint(): string {
  const buf = randomBytes(8);
  let n = 0n;
  for (let i = 0; i < buf.length; i++) {
    n = (n << 8n) | BigInt(buf[i]!);
  }
  return n.toString();
}
