import {
  PublicKey,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

/**
 * SPL Memo Program (v2) address. The x402 SVM spec REQUIRES a Memo
 * instruction in every payment transaction to ensure on-chain
 * uniqueness across concurrent payments with identical parameters.
 * Phantom/Solflare wallet-injected Lighthouse instructions are
 * allowed but optional; the Memo is the canonical uniqueness
 * mechanism.
 */
export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

/** Build a Memo program instruction whose data is the given UTF-8 string. */
export function buildMemoInstruction(memo: string): TransactionInstruction {
  return new TransactionInstruction({
    keys: [],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(memo, "utf8"),
  });
}

export interface BuildTransferCheckedParams {
  /** Token mint (the SPL token being transferred, base58 string). */
  mint: PublicKey;
  /** Source token holder — the payer's wallet pubkey. */
  ownerPubkey: PublicKey;
  /** Recipient's wallet pubkey (NOT the ATA — we derive the ATA). */
  recipientPubkey: PublicKey;
  /** Atomic-unit amount (base units, not human-readable). */
  amount: bigint;
  /** Decimals for `transferChecked` safety (USDC = 6, EURC = 6). */
  decimals: number;
}

export interface TransferCheckedBundle {
  /** The transferChecked instruction itself. */
  instruction: TransactionInstruction;
  /** Source ATA — derived from (ownerPubkey, mint). */
  sourceAta: PublicKey;
  /** Destination ATA — derived from (recipientPubkey, mint). */
  destinationAta: PublicKey;
}

/**
 * Build the `transferChecked` instruction for the x402 SVM exact
 * scheme. Source and destination are Associated Token Accounts
 * derived from `(owner, mint)` and `(recipient, mint)` respectively
 * under the standard SPL Token program.
 *
 * Token-2022 is out of scope for Phase 3 — the spec allows it but
 * USDC native and EURC native both still use the original SPL Token
 * program.
 */
export function buildTransferChecked(
  params: BuildTransferCheckedParams,
): TransferCheckedBundle {
  const sourceAta = getAssociatedTokenAddressSync(
    params.mint,
    params.ownerPubkey,
    false,
    TOKEN_PROGRAM_ID,
  );
  const destinationAta = getAssociatedTokenAddressSync(
    params.mint,
    params.recipientPubkey,
    false,
    TOKEN_PROGRAM_ID,
  );
  const instruction = createTransferCheckedInstruction(
    sourceAta,
    params.mint,
    destinationAta,
    params.ownerPubkey,
    params.amount,
    params.decimals,
    [],
    TOKEN_PROGRAM_ID,
  );
  return { instruction, sourceAta, destinationAta };
}

/** Compute budget instruction limit recommended for a single SPL transfer. */
export const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000;

/**
 * Compute unit price in microlamports. The x402 SVM spec caps this at
 * 5 lamports per CU (5_000_000 microlamports) as a fee-payer safety
 * measure; 1000 microlamports per CU is plenty for an SPL transfer
 * and well below the cap.
 */
export const DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1000;

/** Build the two ComputeBudget instructions required by the spec. */
export function buildComputeBudgetInstructions(
  unitLimit: number = DEFAULT_COMPUTE_UNIT_LIMIT,
  unitPriceMicroLamports: number = DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
): readonly [TransactionInstruction, TransactionInstruction] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: unitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: unitPriceMicroLamports,
    }),
  ];
}
