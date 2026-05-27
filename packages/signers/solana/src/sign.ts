import { randomBytes } from "node:crypto";
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { deriveKeypair } from "./derive.js";
import {
  buildComputeBudgetInstructions,
  buildMemoInstruction,
  buildTransferChecked,
} from "./transferChecked.js";
import {
  type PaymentPayload,
  type PaymentRequirements,
  type SignedRequest,
  SCHEME,
  SOLANA_MAINNET,
} from "./types.js";

export interface SignParams {
  /** BIP-39 mnemonic OR base58-encoded 64-byte SPL secret key. */
  secret: string;
  /** CAIP-2 network. Must be `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (mainnet). */
  network: string;
  /** PaymentRequirements as advertised by the resource server. */
  requirements: PaymentRequirements;
  /** Atomic-unit amount; must equal `requirements.maxAmountRequired`. */
  amount: string;
  /**
   * Recent Solana blockhash (base58). The signer does NOT fetch this
   * from RPC — production callers should obtain it via
   * `connection.getLatestBlockhash()` and pass it in. Tests pass a
   * fixed value so they remain deterministic and offline.
   */
  recentBlockhash: string;
  /**
   * Override the compute-unit price (microlamports). Capped at
   * 5_000_000 (5 lamports/CU) by the x402 SVM spec. Default 1000.
   */
  computeUnitPriceMicroLamports?: number;
  /** Override CU limit. Default 200_000 — plenty for one transferChecked. */
  computeUnitLimit?: number;
  /**
   * Override the random memo. Test-only — production callers leave
   * undefined so we mint a fresh 16-byte hex memo per signature.
   */
  memoOverride?: string;
}

const PROTOCOL_VERSION = 2;

/**
 * Produce a {paymentPayload, paymentRequirements} pair ready to POST
 * to an x402 facilitator's /verify or /settle. The signed transaction
 * is partially-signed — the payer's signature covers the payer's
 * authority over the SPL TransferChecked, and the facilitator
 * (`extra.feePayer`) signs and submits.
 *
 * Wire format per specs/schemes/exact/scheme_exact_svm.md:
 *   - `payload.transaction` is base64 of a serialized
 *     `VersionedTransaction` (legacy message format, v0).
 *   - Instruction layout: ComputeBudget × 2, then TransferChecked,
 *     then Memo (required for uniqueness).
 */
export async function signPaymentPayload(
  params: SignParams,
): Promise<SignedRequest> {
  if (params.network !== SOLANA_MAINNET) {
    throw new Error(
      `unsupported network ${params.network}; signer-solana only supports ${SOLANA_MAINNET}`,
    );
  }
  if (params.requirements.network !== params.network) {
    throw new Error(
      `requirements.network (${params.requirements.network}) disagrees with params.network (${params.network})`,
    );
  }
  if (params.requirements.scheme !== SCHEME) {
    throw new Error(
      `requirements.scheme is '${params.requirements.scheme}'; signer-solana only handles '${SCHEME}'`,
    );
  }
  if (params.amount !== params.requirements.maxAmountRequired) {
    throw new Error(
      `amount '${params.amount}' must equal requirements.maxAmountRequired '${params.requirements.maxAmountRequired}' ` +
        `(SVM exact scheme requires exact match)`,
    );
  }

  const feePayerStr = params.requirements.extra.feePayer;
  if (typeof feePayerStr !== "string" || feePayerStr.length === 0) {
    throw new Error(
      "requirements.extra.feePayer is required (SVM facilitator's pubkey, base58)",
    );
  }

  // Decimals MUST be supplied or we can't safely build transferChecked.
  // USDC and EURC are 6 decimals; check `extra.decimals` first, then
  // default to 6 for known stablecoin mints. Anything else throws.
  const decimals = resolveDecimals(params.requirements);

  const keypair = deriveKeypair(params.secret);
  const ownerPubkey = keypair.publicKey;
  const feePayerPubkey = new PublicKey(feePayerStr);
  const recipientPubkey = new PublicKey(params.requirements.payTo);
  const mint = new PublicKey(params.requirements.asset);

  // Fee-payer safety check from the spec: the fee payer MUST NOT be the
  // source authority. The facilitator (feePayer) should be a separate
  // account from the payer; if they collide, the facilitator could
  // sponsor a payment that drains its own funds.
  if (feePayerPubkey.equals(ownerPubkey)) {
    throw new Error(
      "extra.feePayer equals the payer's pubkey — the spec forbids the fee payer from being the source authority",
    );
  }

  const { instruction: transferIx, sourceAta, destinationAta } = buildTransferChecked({
    mint,
    ownerPubkey,
    recipientPubkey,
    amount: BigInt(params.amount),
    decimals,
  });

  // Additional spec safety: the fee payer must not appear in any
  // instruction's account list.
  for (const acc of transferIx.keys) {
    if (acc.pubkey.equals(feePayerPubkey)) {
      throw new Error(
        "extra.feePayer appears in a transferChecked account slot — refusing to sign (spec violation)",
      );
    }
  }
  if (feePayerPubkey.equals(sourceAta) || feePayerPubkey.equals(destinationAta)) {
    throw new Error(
      "extra.feePayer equals source or destination ATA — refusing to sign",
    );
  }

  const memoText =
    params.memoOverride ??
    params.requirements.extra.memo ??
    randomBytes(16).toString("hex");
  if (Buffer.byteLength(memoText, "utf8") > 256) {
    throw new Error("memo exceeds 256 bytes (spec limit)");
  }

  const [cuLimitIx, cuPriceIx] = buildComputeBudgetInstructions(
    params.computeUnitLimit,
    params.computeUnitPriceMicroLamports,
  );

  const message = new TransactionMessage({
    payerKey: feePayerPubkey,
    recentBlockhash: params.recentBlockhash,
    instructions: [cuLimitIx, cuPriceIx, transferIx, buildMemoInstruction(memoText)],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  // Partial sign: only the payer's signature is supplied. The
  // facilitator will fill in the feePayer signature server-side
  // before submitting. VersionedTransaction.sign overwrites only the
  // signature slots matching the provided keypairs; the feePayer
  // slot stays zeroed until the facilitator co-signs.
  tx.sign([keypair]);

  // VersionedTransaction.serialize() doesn't have a
  // requireAllSignatures option (unlike legacy Transaction) — it
  // emits whatever signatures are populated. Empty slots stay as
  // 64 zero bytes for the facilitator to fill in.
  const serialized = tx.serialize();
  const transactionBase64 = Buffer.from(serialized).toString("base64");

  const paymentPayload: PaymentPayload = {
    x402Version: PROTOCOL_VERSION,
    scheme: SCHEME,
    network: params.network,
    payload: { transaction: transactionBase64 },
  };

  return {
    paymentPayload,
    paymentRequirements: params.requirements,
  };
}

/**
 * SPL token mint → decimals lookup for the stablecoins we handle.
 * Caller-provided `extra.decimals` wins when present.
 */
const KNOWN_MINT_DECIMALS: Record<string, number> = {
  // USDC (Circle native mainnet)
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6,
  // EURC (Circle native mainnet)
  HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr: 6,
};

function resolveDecimals(req: PaymentRequirements): number {
  if (typeof req.extra.decimals === "number") return req.extra.decimals;
  const decimals = KNOWN_MINT_DECIMALS[req.asset];
  if (decimals !== undefined) return decimals;
  throw new Error(
    `cannot determine token decimals for mint ${req.asset}; ` +
      `pass extra.decimals or add the mint to KNOWN_MINT_DECIMALS in signer-solana`,
  );
}

export { SCHEME, SOLANA_MAINNET };
