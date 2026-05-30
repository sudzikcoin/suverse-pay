/**
 * Cosmos signer — `exact_cosmos_authz` scheme on `cosmos:noble-1`
 * (mainnet) and `cosmos:grand-1` (testnet). The proven wire format
 * was vendored from `packages/signers/cosmos/src/{adr036,derive,sign}.ts`
 * in this monorepo and from the production
 * `pay-suverse-agentos-cosmos.mjs` script on AgentOS — both have
 * settled real on-chain payments through the cosmos-pay facilitator.
 *
 * Sign flow:
 *
 *   1. Derive the secp256k1 keypair from the BIP-39 mnemonic at
 *      Cosmos HD path `m/44'/118'/0'/0/0`.
 *   2. Build the structured `Authorization` (from, to, denom, amount,
 *      nonce, validAfter, validBefore, resource, chainId).
 *   3. Canonical-JSON it (recursive lexical sort, HTML-escape
 *      `&` `<` `>`), wrap in the ADR-036 outer doc, canonical-JSON
 *      that too — those bytes are the preimage.
 *   4. SHA-256 the preimage, sign with secp256k1, take r||s (64
 *      bytes — NOT DER, NOT 65-byte recoverable).
 *   5. Pack `{from, publicKey: base64(compressed pubkey 33 bytes),
 *      signature: base64(r||s), authorization}` into the v2
 *      PaymentEnvelope. base64 the JSON for the
 *      `PAYMENT-SIGNATURE` header.
 *
 * Pre-condition (NOT enforced by the signer): the payer's wallet
 * must have run an on-chain `MsgGrant{SendAuthorization}` to the
 * facilitator grantee (`requirement.extra.facilitator`) before any
 * payment can verify or settle. The signer just produces the
 * signed authorization; the facilitator's verify step queries the
 * grant on-chain and rejects if missing.
 */

import { randomBytes } from "node:crypto";
import { rawSecp256k1PubkeyToRawAddress } from "@cosmjs/amino";
import {
  Bip39,
  EnglishMnemonic,
  Secp256k1,
  Sha256,
  Slip10,
  Slip10Curve,
  stringToPath,
} from "@cosmjs/crypto";
import { toBase64, toBech32, toUtf8 } from "@cosmjs/encoding";
import {
  isSupportedCosmosNetwork,
  lookupCosmosNetwork,
} from "../network/cosmos-networks.js";
import {
  X402ClientError,
  type AcceptedRequirement,
  type CosmosWallet,
  type PaymentEnvelope,
} from "../types.js";

export const COSMOS_SCHEME = "exact_cosmos_authz" as const;
export const COSMOS_HD_PATH = "m/44'/118'/0'/0/0";

/**
 * Wire-format Authorization struct. Field order in this interface is
 * irrelevant — the canonical JSON serialization re-sorts keys
 * lexicographically — but JSON field NAMES and TYPES are part of
 * what the payer signs. Match byte-for-byte:
 *
 *   - amount + nonce are strings.
 *   - validAfter + validBefore are NUMBERS (unix seconds). The Go
 *     facilitator decodes them as `uint64`; sending them as strings
 *     breaks signature verification.
 *   - nonce is `0x` + 64 hex chars (32 bytes raw).
 */
export interface Authorization {
  readonly from: string;
  readonly to: string;
  readonly denom: string;
  readonly amount: string;
  readonly nonce: string;
  readonly validAfter: number;
  readonly validBefore: number;
  readonly resource: string;
  readonly chainId: string;
}

export interface CosmosPayloadShape {
  readonly from: string;
  /** base64 of the 33-byte compressed secp256k1 pubkey. */
  readonly publicKey: string;
  /** base64 of the 64-byte r||s signature. NOT DER. */
  readonly signature: string;
  readonly authorization: Authorization;
}

export interface CosmosSignerOptions {
  readonly wallet: CosmosWallet;
  /**
   * Validity window in seconds. validAfter = now - 2,
   * validBefore = validAfter + validitySeconds. Clamped down to the
   * seller's `requirement.maxTimeoutSeconds`. Default 60.
   */
  readonly validitySeconds?: number;
}

export interface CosmosSignParams {
  readonly requirement: AcceptedRequirement;
  /**
   * The resource URL the buyer is paying for. Part of the signed
   * preimage. Pass through `challenge.resource.url` — the
   * SuverseClient does this automatically when you call `.fetch()`
   * or `.signFor(challenge)`.
   */
  readonly resource: string;
  /** Test-only — pin `now` (seconds). */
  readonly nowOverride?: number;
  /** Test-only — pin the 32-byte nonce as `0x` + 64 hex. */
  readonly nonceOverride?: string;
}

// ---------------------------------------------------------------
// Canonical JSON / ADR-036 — vendored proven utilities
// ---------------------------------------------------------------

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
  const out: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    out[k] = sortValue((value as Record<string, unknown>)[k]);
  }
  return out;
}

function sortedJsonStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function escapeJsonHtmlChars(input: string): string {
  return input
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

export function canonicalAuthorizationJson(auth: Authorization): string {
  return escapeJsonHtmlChars(sortedJsonStringify(auth));
}

export function adr036Preimage(
  auth: Authorization,
  payerAddress: string,
): Uint8Array {
  const innerJson = canonicalAuthorizationJson(auth);
  const dataB64 = toBase64(toUtf8(innerJson));
  const doc = {
    account_number: "0",
    chain_id: "",
    fee: { amount: [] as unknown[], gas: "0" },
    memo: "",
    msgs: [
      {
        type: "sign/MsgSignData",
        value: { data: dataB64, signer: payerAddress },
      },
    ],
    sequence: "0",
  };
  return toUtf8(escapeJsonHtmlChars(sortedJsonStringify(doc)));
}

// ---------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------

interface DerivedKey {
  readonly privkey: Uint8Array;
  readonly pubkeyCompressed: Uint8Array;
  readonly address: string;
}

async function deriveFromMnemonic(
  mnemonic: string,
  bech32Prefix: string,
): Promise<DerivedKey> {
  const checked = new EnglishMnemonic(mnemonic);
  const seed = await Bip39.mnemonicToSeed(checked);
  const { privkey } = Slip10.derivePath(
    Slip10Curve.Secp256k1,
    seed,
    stringToPath(COSMOS_HD_PATH),
  );
  return finalizeKey(privkey, bech32Prefix);
}

async function finalizeKey(
  privkey: Uint8Array,
  bech32Prefix: string,
): Promise<DerivedKey> {
  const kp = await Secp256k1.makeKeypair(privkey);
  const pubkeyCompressed = Secp256k1.compressPubkey(kp.pubkey);
  const address = toBech32(
    bech32Prefix,
    rawSecp256k1PubkeyToRawAddress(pubkeyCompressed),
  );
  return { privkey, pubkeyCompressed, address };
}

// ---------------------------------------------------------------
// CosmosSigner class
// ---------------------------------------------------------------

export class CosmosSigner {
  private readonly wallet: CosmosWallet;
  private readonly validitySeconds: number;
  // Cache derived keys per (mnemonic, prefix) so we don't re-derive
  // on every sign — Bip39 seed derivation is multi-millisecond.
  private readonly keyCache = new Map<string, DerivedKey>();

  constructor(options: CosmosSignerOptions) {
    this.wallet = options.wallet;
    this.validitySeconds = options.validitySeconds ?? 60;
    if (this.validitySeconds <= 0) {
      throw new X402ClientError(
        "invalid_validity",
        "validitySeconds must be positive",
      );
    }
    // Validate wallet shape eagerly so a misconfigured client fails
    // at construction, not on the first 402.
    if (typeof this.wallet === "string") {
      const words = this.wallet.trim().split(/\s+/);
      if (words.length !== 12 && words.length !== 24) {
        throw new X402ClientError(
          "invalid_wallet",
          `Cosmos mnemonic must be 12 or 24 BIP-39 words; got ${words.length}`,
        );
      }
    } else if (this.wallet instanceof Uint8Array) {
      if (this.wallet.length !== 32) {
        throw new X402ClientError(
          "invalid_wallet",
          `Cosmos raw private key must be exactly 32 bytes; got ${this.wallet.length}`,
        );
      }
    } else {
      throw new X402ClientError(
        "invalid_wallet",
        "Cosmos wallet must be a BIP-39 mnemonic string or a 32-byte Uint8Array",
      );
    }
  }

  static supportedNetworks(): readonly string[] {
    return ["cosmos:noble-1", "cosmos:grand-1"];
  }

  /** Resolve the bech32 address for the given network's prefix. */
  async address(network = "cosmos:noble-1"): Promise<string> {
    const net = lookupCosmosNetwork(network);
    if (!net) {
      throw new X402ClientError(
        "unsupported_chain",
        `network ${network} is not a recognised Cosmos network`,
      );
    }
    return (await this.deriveKey(net.bech32Prefix)).address;
  }

  async sign(params: CosmosSignParams): Promise<PaymentEnvelope> {
    const { requirement, resource } = params;
    if (requirement.scheme !== COSMOS_SCHEME) {
      throw new X402ClientError(
        "scheme_mismatch",
        `CosmosSigner only supports scheme "${COSMOS_SCHEME}"; got "${requirement.scheme}"`,
      );
    }
    if (!isSupportedCosmosNetwork(requirement.network)) {
      throw new X402ClientError(
        "unsupported_chain",
        `network ${requirement.network} is not a recognised Cosmos network`,
      );
    }
    if (resource.length === 0) {
      throw new X402ClientError(
        "missing_resource",
        "Cosmos signer requires the resource URL (from challenge.resource.url) — it is part of the signed preimage",
      );
    }
    const net = lookupCosmosNetwork(requirement.network)!;
    // Cross-check the chainId portion of network against extra.chainId
    // if seller advertised it.
    const extra = requirement.extra ?? {};
    const extraChainId =
      typeof extra["chainId"] === "string" ? (extra["chainId"] as string) : null;
    if (extraChainId !== null && extraChainId !== net.chainId) {
      throw new X402ClientError(
        "chain_id_mismatch",
        `requirement.extra.chainId "${extraChainId}" disagrees with registry chainId "${net.chainId}" for ${requirement.network}`,
      );
    }
    const facilitator =
      typeof extra["facilitator"] === "string"
        ? (extra["facilitator"] as string)
        : null;
    if (!facilitator) {
      throw new X402ClientError(
        "missing_facilitator",
        "Cosmos requirement is missing extra.facilitator (the bech32 grantee address)",
      );
    }

    const { privkey, pubkeyCompressed, address } = await this.deriveKey(
      net.bech32Prefix,
    );

    const effectiveValidity = Math.min(
      this.validitySeconds,
      requirement.maxTimeoutSeconds,
    );
    const now = params.nowOverride ?? Math.floor(Date.now() / 1000);
    const validAfter = now - 2;
    const validBefore = validAfter + effectiveValidity;

    const nonce = params.nonceOverride ?? freshNonce();

    const auth: Authorization = {
      from: address,
      to: requirement.payTo,
      denom: requirement.asset,
      amount: requirement.amount,
      nonce,
      validAfter,
      validBefore,
      resource,
      chainId: net.chainId,
    };

    const preimage = adr036Preimage(auth, address);
    const digest = new Sha256(preimage).digest();
    const extSig = await Secp256k1.createSignature(digest, privkey);
    const signature = new Uint8Array(64);
    signature.set(extSig.r(32), 0);
    signature.set(extSig.s(32), 32);

    const payload: CosmosPayloadShape = {
      from: address,
      publicKey: toBase64(pubkeyCompressed),
      signature: toBase64(signature),
      authorization: auth,
    };

    return {
      x402Version: 2,
      scheme: COSMOS_SCHEME,
      network: requirement.network,
      accepted: requirement,
      payload: payload as unknown as Record<string, unknown>,
    };
  }

  // -------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------

  private async deriveKey(bech32Prefix: string): Promise<DerivedKey> {
    const cached = this.keyCache.get(bech32Prefix);
    if (cached) return cached;
    const derived =
      typeof this.wallet === "string"
        ? await deriveFromMnemonic(this.wallet.trim(), bech32Prefix)
        : await finalizeKey(this.wallet, bech32Prefix);
    this.keyCache.set(bech32Prefix, derived);
    return derived;
  }
}

// ---------------------------------------------------------------
// Wire-encode helper (mirrors evm.ts/solana.ts toHeaderValue)
// ---------------------------------------------------------------

export function toHeaderValue(envelope: PaymentEnvelope): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

// ---------------------------------------------------------------
// Compat with the dynamic-import shape in client.ts (Phase 1 stub)
// ---------------------------------------------------------------

export async function signCosmosPayment(params: {
  readonly wallet: CosmosWallet;
  readonly requirement: AcceptedRequirement;
  readonly resource: string;
  readonly validitySeconds?: number;
}): Promise<PaymentEnvelope> {
  const signer = new CosmosSigner({
    wallet: params.wallet,
    ...(params.validitySeconds !== undefined
      ? { validitySeconds: params.validitySeconds }
      : {}),
  });
  return signer.sign({
    requirement: params.requirement,
    resource: params.resource,
  });
}

// ---------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------

function freshNonce(): string {
  return "0x" + randomBytes(32).toString("hex");
}
