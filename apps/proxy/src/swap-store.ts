/**
 * Postgres helpers for the SuVerse Swap feature (migration 026).
 *
 * The swap flow has its own lifecycle table (`swap_transactions`)
 * because a swap is not a single HTTP call — it's two:
 *   1. /quote — persists status='quoted' with the Jupiter quote
 *      response cached so /execute does not re-derive routing.
 *   2. /execute/:quote_id — settles inbound x402 payment, then
 *      transitions the same row through executing → completed /
 *      failed / failed_slippage.
 *
 * pg-mem gotcha: `gen_random_uuid()` is not implemented in pg-mem
 * (see memory `reference_pgmem_gotchas`), so we generate the UUID
 * in Node via `crypto.randomUUID()` and pass it explicitly.
 *
 * Nothing in here talks to Jupiter or Solana — those live in
 * `swap-jupiter.ts` and `swap.ts`. This is the storage seam.
 */
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

/** Status state machine for `swap_transactions.status`. */
export type SwapStatus =
  | "quoted"
  | "executing"
  | "completed"
  | "failed"
  | "failed_slippage"
  | "expired";

export interface SwapRow {
  id: string;
  createdAt: Date;
  quoteId: string;
  network: string;
  inputToken: string;
  outputToken: string;
  inputAmount: string;
  expectedOutput: string | null;
  actualOutput: string | null;
  slippageBps: number | null;
  feeAmount: string | null;
  recipientAddress: string | null;
  inboundPaymentId: string | null;
  swapTxHash: string | null;
  status: SwapStatus;
  error: string | null;
  expiresAt: Date | null;
  completedAt: Date | null;
  jupiterQuote: unknown;
}

export interface InsertQuoteArgs {
  quoteId: string;
  network: string;
  inputToken: string;
  outputToken: string;
  inputAmount: string;
  expectedOutput: string;
  slippageBps: number;
  feeAmount: string;
  expiresAt: Date;
  jupiterQuote: unknown;
}

/** Atomic write — runs in autocommit; one row per quote. */
export async function insertQuote(
  pool: Pool | PoolClient,
  args: InsertQuoteArgs,
): Promise<SwapRow> {
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO swap_transactions (
       id, quote_id, network, input_token, output_token,
       input_amount, expected_output, slippage_bps, fee_amount,
       expires_at, status, jupiter_quote
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'quoted',$11)
     RETURNING ${SELECT_COLUMNS}`,
    [
      id,
      args.quoteId,
      args.network,
      args.inputToken,
      args.outputToken,
      args.inputAmount,
      args.expectedOutput,
      args.slippageBps,
      args.feeAmount,
      args.expiresAt.toISOString(),
      JSON.stringify(args.jupiterQuote),
    ],
  );
  return mapRow(rows[0] as RawRow);
}

export async function findByQuoteId(
  pool: Pool | PoolClient,
  quoteId: string,
): Promise<SwapRow | null> {
  const { rows } = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM swap_transactions WHERE quote_id = $1`,
    [quoteId],
  );
  if (rows.length === 0) return null;
  return mapRow(rows[0] as RawRow);
}

export interface MarkExecutingArgs {
  quoteId: string;
  recipientAddress: string;
  inboundPaymentId: string | null;
}

/**
 * Transition quoted → executing. Uses a conditional UPDATE so two
 * concurrent /execute calls for the same quote can't both proceed
 * (the second sees `rowCount === 0` and treats the quote as taken).
 */
export async function markExecuting(
  pool: Pool | PoolClient,
  args: MarkExecutingArgs,
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE swap_transactions
        SET status = 'executing',
            recipient_address = $2,
            inbound_payment_id = $3
      WHERE quote_id = $1 AND status = 'quoted'`,
    [args.quoteId, args.recipientAddress, args.inboundPaymentId],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface MarkCompletedArgs {
  quoteId: string;
  actualOutput: string;
  swapTxHash: string;
}

export async function markCompleted(
  pool: Pool | PoolClient,
  args: MarkCompletedArgs,
): Promise<void> {
  await pool.query(
    `UPDATE swap_transactions
        SET status = 'completed',
            actual_output = $2,
            swap_tx_hash = $3,
            completed_at = NOW()
      WHERE quote_id = $1`,
    [args.quoteId, args.actualOutput, args.swapTxHash],
  );
}

export interface MarkFailedArgs {
  quoteId: string;
  status: "failed" | "failed_slippage" | "expired";
  error: string;
}

export async function markFailed(
  pool: Pool | PoolClient,
  args: MarkFailedArgs,
): Promise<void> {
  await pool.query(
    `UPDATE swap_transactions
        SET status = $2, error = $3
      WHERE quote_id = $1`,
    [args.quoteId, args.status, args.error],
  );
}

export interface RecordRefundArgs {
  swapId: string;
  buyerAddress: string;
  network: string;
  amount: string;
  reason: string;
}

/**
 * Record a pending refund obligation. The v1 design defers actual
 * on-chain refunds to a manual operator (or future cron) — this
 * just commits the bookkeeping row.
 */
export async function recordRefund(
  pool: Pool | PoolClient,
  args: RecordRefundArgs,
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO swap_refunds (
       id, swap_id, buyer_address, network, amount, reason, status
     ) VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
    [id, args.swapId, args.buyerAddress, args.network, args.amount, args.reason],
  );
  return id;
}

interface RawRow {
  id: string;
  created_at: Date;
  quote_id: string;
  network: string;
  input_token: string;
  output_token: string;
  // Driver-dependent — pg returns NUMERIC as string, pg-mem as number.
  input_amount: string | number;
  expected_output: string | number | null;
  actual_output: string | number | null;
  slippage_bps: number | null;
  fee_amount: string | number | null;
  recipient_address: string | null;
  inbound_payment_id: string | null;
  swap_tx_hash: string | null;
  status: SwapStatus;
  error: string | null;
  expires_at: Date | null;
  completed_at: Date | null;
  jupiter_quote: unknown;
}

const SELECT_COLUMNS = `
  id, created_at, quote_id, network, input_token, output_token,
  input_amount, expected_output, actual_output, slippage_bps,
  fee_amount, recipient_address, inbound_payment_id, swap_tx_hash,
  status, error, expires_at, completed_at, jupiter_quote
`;

/**
 * pg returns NUMERIC as `string` to preserve uint256 precision; pg-mem
 * returns it as a JS `number`. Coerce here so downstream code (and
 * tests) can rely on `string | null` regardless of driver.
 */
function toAmount(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : String(v);
}

function mapRow(r: RawRow): SwapRow {
  return {
    id: r.id,
    createdAt: r.created_at,
    quoteId: r.quote_id,
    network: r.network,
    inputToken: r.input_token,
    outputToken: r.output_token,
    inputAmount: toAmount(r.input_amount as string) ?? "0",
    expectedOutput: toAmount(r.expected_output),
    actualOutput: toAmount(r.actual_output),
    slippageBps: r.slippage_bps,
    feeAmount: toAmount(r.fee_amount),
    recipientAddress: r.recipient_address,
    inboundPaymentId: r.inbound_payment_id,
    swapTxHash: r.swap_tx_hash,
    status: r.status,
    error: r.error,
    expiresAt: r.expires_at,
    completedAt: r.completed_at,
    jupiterQuote: r.jupiter_quote,
  };
}
