/**
 * Solana signer — handles `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`
 * (mainnet) and `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet).
 *
 * Wire format per the x402 SVM "exact" scheme: partially-signed
 * VersionedTransaction containing
 *   ComputeBudget setLimit + setPrice + SPL transferChecked + Memo.
 * The buyer signs as the SPL authority; the facilitator
 * (`extra.feePayer`) co-signs and submits.
 *
 * Patterns vendored from `packages/signers/solana/src/sign.ts` — the
 * same code drove the suverse-pay Solana smoke suite end-to-end on
 * PayAI mainnet. We do not depend on the internal pkg because it is
 * not on npm; copying keeps `@suverselabs/x402-client` self-contained.
 *
 * Wallet shapes accepted in v0.1.0:
 *   - `Uint8Array` (32-byte ed25519 seed OR full 64-byte SPL secret key)
 *   - `string` base58-encoded 64-byte SPL secret key (the
 *     `solana-keygen` JSON file format `[a, b, c, ...]` packaged into
 *     base58 — what most agent KMS services hand out).
 *
 * BIP-39 mnemonic support is intentionally NOT in v0.1.0 — adding
 * bip39 + ed25519-hd-key dependencies bloats install size for a
 * niche case. Use `keypairFromBase58SecretKey` on the input or pass
 * the raw bytes directly.
 */

import { randomBytes } from "node:crypto";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import bs58 from "bs58";
import {
  DEFAULT_RPC_URL,
  isSupportedSolanaNetwork,
  lookupToken,
  type SolanaNetwork,
} from "../network/solana-networks.js";
import {
  X402ClientError,
  type AcceptedRequirement,
  type PaymentEnvelope,
  type SolanaWallet,
} from "../types.js";

const SVM_SCHEME = "exact" as const;
const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);
const DEFAULT_CU_LIMIT = 200_000;
const DEFAULT_CU_PRICE_MICRO_LAMPORTS = 1_000;
const MAX_CU_PRICE_MICRO_LAMPORTS = 5_000_000; // spec cap
const MAX_MEMO_BYTES = 256; // spec cap

export interface SolanaSignerOptions {
  readonly wallet: SolanaWallet;
  /**
   * Override the compute unit price in microlamports. Capped at
   * 5_000_000 by the spec; default 1_000 is plenty for one
   * transferChecked.
   */
  readonly computeUnitPriceMicroLamports?: number;
  readonly computeUnitLimit?: number;
  /**
   * Custom JSON-RPC endpoint to use for `recentBlockhash` fetch.
   * Default: the public mainnet / devnet endpoint per network. Pass
   * a Helius / Triton / QuickNode URL for production reliability.
   */
  readonly rpcEndpoint?: string;
}

export interface SolanaSignParams {
  readonly requirement: AcceptedRequirement;
  /**
   * Recent blockhash (base58). When omitted, the signer auto-fetches
   * one from the configured RPC. Tests supply a fixed value for
   * determinism.
   */
  readonly recentBlockhash?: string;
  /** Override the random 16-byte memo. Test-only. */
  readonly memoOverride?: string;
}

export class SolanaSigner {
  private readonly keypair: Keypair;
  private readonly cuLimit: number;
  private readonly cuPrice: number;
  private readonly rpcEndpoint: string | undefined;

  constructor(options: SolanaSignerOptions) {
    this.keypair = resolveKeypair(options.wallet);
    this.cuLimit = options.computeUnitLimit ?? DEFAULT_CU_LIMIT;
    const requestedPrice =
      options.computeUnitPriceMicroLamports ??
      DEFAULT_CU_PRICE_MICRO_LAMPORTS;
    if (requestedPrice <= 0) {
      throw new X402ClientError(
        "invalid_cu_price",
        "computeUnitPriceMicroLamports must be positive",
      );
    }
    if (requestedPrice > MAX_CU_PRICE_MICRO_LAMPORTS) {
      throw new X402ClientError(
        "invalid_cu_price",
        `computeUnitPriceMicroLamports ${requestedPrice} exceeds spec cap ${MAX_CU_PRICE_MICRO_LAMPORTS}`,
      );
    }
    this.cuPrice = requestedPrice;
    this.rpcEndpoint = options.rpcEndpoint;
  }

  /** Buyer's pubkey (base58). */
  get address(): string {
    return this.keypair.publicKey.toBase58();
  }

  static supportedNetworks(): readonly string[] {
    return [
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    ];
  }

  /**
   * Sign a single AcceptedRequirement. Returns a v2 PaymentEnvelope.
   */
  async sign(params: SolanaSignParams): Promise<PaymentEnvelope> {
    const { requirement } = params;
    if (requirement.scheme !== SVM_SCHEME) {
      throw new X402ClientError(
        "scheme_mismatch",
        `SolanaSigner only supports scheme "${SVM_SCHEME}"; got "${requirement.scheme}"`,
      );
    }
    if (!isSupportedSolanaNetwork(requirement.network)) {
      throw new X402ClientError(
        "unsupported_chain",
        `network ${requirement.network} is not a recognised Solana mainnet/devnet identifier`,
      );
    }
    const network = requirement.network as SolanaNetwork;

    const extra = requirement.extra ?? {};
    const feePayerStr =
      typeof extra["feePayer"] === "string"
        ? (extra["feePayer"] as string)
        : null;
    if (!feePayerStr) {
      throw new X402ClientError(
        "missing_fee_payer",
        "Solana requirement is missing extra.feePayer (the facilitator's pubkey)",
      );
    }

    const decimals = resolveDecimals(requirement, network);

    const mint = parsePubkeyOrThrow(requirement.asset, "asset");
    const recipient = parsePubkeyOrThrow(requirement.payTo, "payTo");
    const feePayer = parsePubkeyOrThrow(feePayerStr, "extra.feePayer");
    const payer = this.keypair.publicKey;

    // Spec safety: fee payer must not be the source authority and
    // must not coincide with source/destination ATAs.
    if (feePayer.equals(payer)) {
      throw new X402ClientError(
        "fee_payer_collision",
        "extra.feePayer equals the payer's pubkey — the spec forbids the fee payer from being the source authority",
      );
    }

    const sourceAta = getAssociatedTokenAddressSync(
      mint,
      payer,
      false,
      TOKEN_PROGRAM_ID,
    );
    const destinationAta = getAssociatedTokenAddressSync(
      mint,
      recipient,
      false,
      TOKEN_PROGRAM_ID,
    );
    if (feePayer.equals(sourceAta) || feePayer.equals(destinationAta)) {
      throw new X402ClientError(
        "fee_payer_collision",
        "extra.feePayer equals source or destination ATA — refusing to sign",
      );
    }

    const transferIx = createTransferCheckedInstruction(
      sourceAta,
      mint,
      destinationAta,
      payer,
      BigInt(requirement.amount),
      decimals,
      [],
      TOKEN_PROGRAM_ID,
    );

    const memoText = params.memoOverride ?? randomBytes(16).toString("hex");
    if (Buffer.byteLength(memoText, "utf8") > MAX_MEMO_BYTES) {
      throw new X402ClientError(
        "memo_too_long",
        `memo exceeds ${MAX_MEMO_BYTES} bytes`,
      );
    }
    const memoIx = new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memoText, "utf8"),
    });

    const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: this.cuLimit,
    });
    const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: this.cuPrice,
    });

    const recentBlockhash =
      params.recentBlockhash ?? (await this.fetchRecentBlockhash(network));

    const message = new TransactionMessage({
      payerKey: feePayer,
      recentBlockhash,
      instructions: [cuLimitIx, cuPriceIx, transferIx, memoIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([this.keypair]);

    const transactionBase64 = Buffer.from(tx.serialize()).toString("base64");

    return {
      x402Version: 2,
      scheme: SVM_SCHEME,
      network: requirement.network,
      accepted: requirement,
      payload: { transaction: transactionBase64 },
    };
  }

  private async fetchRecentBlockhash(network: SolanaNetwork): Promise<string> {
    const url = this.rpcEndpoint ?? DEFAULT_RPC_URL[network];
    const conn = new Connection(url, "confirmed");
    try {
      const { blockhash } = await conn.getLatestBlockhash("confirmed");
      return blockhash;
    } catch (err) {
      throw new X402ClientError(
        "blockhash_fetch_failed",
        `failed to fetch recent blockhash from ${url}: ${(err as Error).message}. Pass options.rpcEndpoint or params.recentBlockhash to override.`,
      );
    }
  }
}

// ---------------------------------------------------------------
// Wire-encode helper (mirrors evm.ts toHeaderValue)
// ---------------------------------------------------------------

export function toHeaderValue(envelope: PaymentEnvelope): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

// ---------------------------------------------------------------
// Wallet resolution
// ---------------------------------------------------------------

function resolveKeypair(wallet: SolanaWallet): Keypair {
  if (wallet instanceof Uint8Array) {
    if (wallet.length === 32) return Keypair.fromSeed(wallet);
    if (wallet.length === 64) return Keypair.fromSecretKey(wallet);
    throw new X402ClientError(
      "invalid_wallet",
      `Solana wallet Uint8Array must be 32 bytes (seed) or 64 bytes (full secret key); got ${wallet.length}`,
    );
  }
  if (typeof wallet === "string") {
    let decoded: Uint8Array;
    try {
      decoded = bs58.decode(wallet.trim());
    } catch (err) {
      throw new X402ClientError(
        "invalid_wallet",
        `Solana wallet string did not base58-decode: ${(err as Error).message}`,
      );
    }
    if (decoded.length === 32) return Keypair.fromSeed(decoded);
    if (decoded.length === 64) return Keypair.fromSecretKey(decoded);
    throw new X402ClientError(
      "invalid_wallet",
      `Solana wallet decoded to ${decoded.length} bytes; expected 32 (seed) or 64 (secret key)`,
    );
  }
  throw new X402ClientError(
    "invalid_wallet",
    "Solana wallet must be a Uint8Array or base58-encoded string",
  );
}

function parsePubkeyOrThrow(value: string, label: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch (err) {
    throw new X402ClientError(
      "invalid_pubkey",
      `${label} is not a valid Solana pubkey: ${(err as Error).message}`,
    );
  }
}

function resolveDecimals(
  requirement: AcceptedRequirement,
  network: SolanaNetwork,
): number {
  const extra = requirement.extra ?? {};
  if (typeof extra["decimals"] === "number") {
    return extra["decimals"] as number;
  }
  const known = lookupToken(network, requirement.asset);
  if (known) return known.decimals;
  throw new X402ClientError(
    "unknown_decimals",
    `cannot infer SPL token decimals for ${requirement.asset} on ${requirement.network}; seller's challenge should include extra.decimals or use a known mint (USDC EPjFW… / USDT Es9vMFrz…)`,
  );
}

// ---------------------------------------------------------------
// Compat with the dynamic import in client.ts (Phase 1 stub shape)
// ---------------------------------------------------------------

/**
 * Functional shim kept so the old dynamic import in
 * `client.ts.signRequirement` (Phase 1 stub path) still works without
 * a circular refactor. Internally just constructs a SolanaSigner and
 * calls `.sign`.
 */
export async function signSolanaPayment(params: {
  readonly wallet: SolanaWallet;
  readonly requirement: AcceptedRequirement;
  readonly recentBlockhash?: string;
  readonly rpcEndpoint?: string;
}): Promise<PaymentEnvelope> {
  const signer = new SolanaSigner({
    wallet: params.wallet,
    ...(params.rpcEndpoint !== undefined
      ? { rpcEndpoint: params.rpcEndpoint }
      : {}),
  });
  return signer.sign({
    requirement: params.requirement,
    ...(params.recentBlockhash !== undefined
      ? { recentBlockhash: params.recentBlockhash }
      : {}),
  });
}
