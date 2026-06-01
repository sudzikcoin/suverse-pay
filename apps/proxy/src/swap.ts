/**
 * SuVerse Solana token swap — paid via x402, routed via Jupiter.
 *
 * Two routes, registered side-by-side with the rest of the proxy:
 *
 *   POST /v1/swap/solana/quote         — FREE
 *   POST /v1/swap/solana/execute/:id   — x402-paid (dynamic price)
 *
 * The quote endpoint is a plain JSON API: validate, call Jupiter,
 * persist a row in `swap_transactions`, return the buyer everything
 * they need to pay (quote_id, total_cost, x402_pay_url).
 *
 * The execute endpoint is special. The standard proxy pipeline
 * `handle()` derives the x402 price from `seller_proxy_configs.price`
 * — a static column. Swap pricing is per-quote (depends on the
 * Jupiter route + our 1% service fee). So execute orchestrates
 * `runProtocol()` directly, building the `AcceptedPayment[]` from
 * the cached quote row's `expected fee + input_amount` total.
 *
 * On-chain orchestration: the proxy holds a dedicated liquidity
 * wallet (`SWAP_SOLANA_ADDRESS`) — fully separate from the upstream
 * `SERVICE_SOLANA_*` wallet used for outbound x402. The liquidity
 * wallet:
 *   1. holds USDC for swap input,
 *   2. signs + sends the Jupiter swap (deposits output to itself),
 *   3. transfers the output to the buyer's payer address.
 *
 * Refunds: this v1 records a row in `swap_refunds` with
 * status='pending' but does NOT broadcast an on-chain refund. A
 * separate operator workflow drains pending refunds (out of scope
 * here).
 *
 * Test surface: `executeSolanaSwap()` and helpers are exported so a
 * vitest suite can drive the orchestration without booting Fastify
 * or hitting Solana mainnet (`SolanaTxSender` is injected).
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  type Commitment,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { runProtocol } from "@suverselabs/x402-server";
import type {
  AcceptedPayment,
  MiddlewareOptions,
} from "@suverselabs/x402-server";
import {
  fetchJupiterQuote,
  fetchJupiterSwap,
  JupiterError,
  type JupiterQuoteResponse,
} from "./swap-jupiter.js";
import {
  formatTokenAmount,
  getTokenMetadata,
  type TokenMetadata,
} from "./lib/token-metadata.js";
import {
  findByQuoteId,
  insertQuote,
  markCompleted,
  markExecuting,
  markFailed,
  recordRefund,
  type SwapRow,
} from "./swap-store.js";

// ---------------------------------------------------------------- consts ----

/** USDC mint on Solana mainnet. */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** Wrapped SOL mint (used for SOL outputs via wrapAndUnwrapSol=true). */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
/** CAIP-2 for Solana mainnet — matches networks.ts. */
export const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/** Max swappable input in USDC atomic units (6 decimals → 50_000_000 = $50). */
export const MAX_INPUT_USDC_ATOMIC = 50_000_000n;
/** Service fee in basis points (1%). */
export const FEE_BPS = 100n;
/** Slippage tolerance bounds — buyers can ask anywhere in [10, 500] bps. */
export const MIN_SLIPPAGE_BPS = 10;
export const MAX_SLIPPAGE_BPS = 500;
/** A quote is honored for this long after creation. */
export const QUOTE_TTL_SECONDS = 60;
/**
 * If the re-quote at execute time differs from the cached quote by
 * more than this fraction, treat it as price drift and fail rather
 * than swap. 200 bps = 2%.
 */
export const REQUOTE_DRIFT_BPS = 200n;
/** Solana RPC confirmation level — `confirmed` is fast and durable. */
export const RPC_COMMITMENT: Commitment = "confirmed";
/** Max wait for the swap tx to confirm before we declare failure. */
export const CONFIRM_TIMEOUT_MS = 30_000;

// --------------------------------------------------------------- env load ----

export interface SwapSignerConfig {
  /** Base58 string of the public key. */
  address: string;
  /** Raw 64-byte secret key bytes (solana-keygen JSON array). */
  secretKey: Uint8Array;
}

/**
 * Read the dedicated swap liquidity wallet from env. Returns
 * `undefined` if either var is absent — caller can then skip swap
 * route registration without crashing the proxy boot for everyone
 * else.
 */
export function loadSwapSigner(
  env: NodeJS.ProcessEnv = process.env,
): SwapSignerConfig | undefined {
  const address = env["SWAP_SOLANA_ADDRESS"];
  const path = env["SWAP_SOLANA_PRIVKEY_PATH"];
  if (!address || !path) return undefined;
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  if (!Array.isArray(raw) || raw.length !== 64) {
    throw new Error(
      `SWAP_SOLANA_PRIVKEY_PATH at ${path} is not a 64-byte JSON array`,
    );
  }
  const secretKey = Uint8Array.from(raw);
  // Sanity check — derived address must match the configured one.
  const derived = Keypair.fromSecretKey(secretKey).publicKey.toBase58();
  if (derived !== address) {
    throw new Error(
      `SWAP_SOLANA_ADDRESS=${address} does not match keypair at ${path} (derived ${derived})`,
    );
  }
  return { address, secretKey };
}

// ------------------------------------------------------- chain abstraction ----

/**
 * Solana operations the swap orchestrator needs. Pulled into a
 * narrow interface so vitest can stub it without spinning up an RPC
 * connection. The production impl in this file wraps
 * `@solana/web3.js`.
 */
export interface SolanaSwapChain {
  /**
   * Signs the base64-encoded VersionedTransaction with the swap
   * keypair, broadcasts, and waits for `confirmed`. Returns the
   * signature on success or throws.
   */
  signAndSendVersionedSwap(args: {
    swapTransactionB64: string;
  }): Promise<{ signature: string }>;

  /**
   * Transfer `amount` of `mint` from the swap wallet to `recipient`.
   * Creates the recipient ATA if missing (paying rent from the swap
   * wallet). Returns the transfer signature.
   *
   * If `mint === WSOL_MINT`, treats it as native SOL transfer
   * (SystemProgram.transfer) — Jupiter's `unwrapSol=true` will have
   * already credited native SOL to the swap wallet.
   */
  transferOutput(args: {
    mint: string;
    amount: bigint;
    recipient: string;
  }): Promise<{ signature: string }>;

  /**
   * Read the current SPL token balance held by the swap wallet for
   * `mint`. Used to validate that the swap actually credited the
   * expected output before we forward to the buyer. For native SOL,
   * pass WSOL_MINT and we'll lamport-query the wallet.
   */
  readSwapWalletBalance(mint: string): Promise<bigint>;
}

/**
 * Production implementation backed by @solana/web3.js + a Helius RPC.
 *
 * Boot path: `loadSwapSigner` provides the keypair; the rpcUrl
 * defaults to Helius mainnet using HELIUS_API_KEY but can be
 * overridden by SOLANA_RPC_URL for self-hosted RPCs.
 */
export class Web3SolanaSwapChain implements SolanaSwapChain {
  private readonly conn: Connection;
  private readonly keypair: Keypair;

  constructor(args: { rpcUrl: string; secretKey: Uint8Array }) {
    this.conn = new Connection(args.rpcUrl, RPC_COMMITMENT);
    this.keypair = Keypair.fromSecretKey(args.secretKey);
  }

  async signAndSendVersionedSwap(args: {
    swapTransactionB64: string;
  }): Promise<{ signature: string }> {
    const txBytes = Buffer.from(args.swapTransactionB64, "base64");
    const tx = VersionedTransaction.deserialize(txBytes);
    tx.sign([this.keypair]);
    const signature = await this.conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    const latest = await this.conn.getLatestBlockhash(RPC_COMMITMENT);
    const result = await Promise.race([
      this.conn.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        RPC_COMMITMENT,
      ),
      new Promise<never>((_, rej) =>
        setTimeout(
          () => rej(new Error("swap_confirm_timeout")),
          CONFIRM_TIMEOUT_MS,
        ),
      ),
    ]);
    if (
      result &&
      typeof result === "object" &&
      "value" in result &&
      (result as { value: { err: unknown } }).value.err
    ) {
      throw new Error(
        `swap_tx_failed: ${JSON.stringify(
          (result as { value: { err: unknown } }).value.err,
        )}`,
      );
    }
    return { signature };
  }

  async transferOutput(args: {
    mint: string;
    amount: bigint;
    recipient: string;
  }): Promise<{ signature: string }> {
    const recipientPk = new PublicKey(args.recipient);
    if (args.mint === WSOL_MINT) {
      // Native SOL — wrapAndUnwrapSol on the swap call should have
      // already left the swap wallet holding lamports. Transfer
      // directly.
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.keypair.publicKey,
          toPubkey: recipientPk,
          lamports: Number(args.amount),
        }),
      );
      const signature = await this.conn.sendTransaction(tx, [this.keypair], {
        skipPreflight: false,
      });
      await this.conn.confirmTransaction(signature, RPC_COMMITMENT);
      return { signature };
    }

    const mintPk = new PublicKey(args.mint);
    const sourceAta = getAssociatedTokenAddressSync(
      mintPk,
      this.keypair.publicKey,
    );
    const destAta = getAssociatedTokenAddressSync(mintPk, recipientPk);

    const instructions: TransactionInstruction[] = [];
    // Create destination ATA if missing — first SPL receipt from a
    // wallet that's never held this token pays rent from us.
    const destInfo = await this.conn.getAccountInfo(destAta);
    if (destInfo === null) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          this.keypair.publicKey,
          destAta,
          recipientPk,
          mintPk,
        ),
      );
    }
    instructions.push(
      createTransferInstruction(
        sourceAta,
        destAta,
        this.keypair.publicKey,
        args.amount,
        [],
        TOKEN_PROGRAM_ID,
      ),
    );
    const tx = new Transaction().add(...instructions);
    const signature = await this.conn.sendTransaction(tx, [this.keypair], {
      skipPreflight: false,
    });
    await this.conn.confirmTransaction(signature, RPC_COMMITMENT);
    return { signature };
  }

  async readSwapWalletBalance(mint: string): Promise<bigint> {
    if (mint === WSOL_MINT) {
      const lamports = await this.conn.getBalance(this.keypair.publicKey);
      return BigInt(lamports);
    }
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(mint),
      this.keypair.publicKey,
    );
    try {
      const acc = await getAccount(this.conn, ata);
      return acc.amount;
    } catch {
      return 0n;
    }
  }
}

// --------------------------------------------------------- shared quoting ----

export interface ValidatedQuoteRequest {
  inputMint: string;
  outputMint: string;
  inputAmount: bigint;
  slippageBps: number;
}

/**
 * Validate and normalize the public /quote input. Returns either the
 * coerced shape or an error code the route hands to the caller as a
 * 400.
 *
 * Hardcoded constraints:
 *   - input_mint MUST be USDC mainnet (v1 only accepts USDC-in).
 *   - output_mint MUST NOT equal input_mint.
 *   - input_amount in (0, MAX_INPUT_USDC_ATOMIC] atomic units.
 *   - slippage_bps in [MIN, MAX].
 *   - mint strings must parse as Solana PublicKeys.
 */
export function validateQuoteInput(raw: unknown):
  | { ok: true; req: ValidatedQuoteRequest }
  | { ok: false; error: string; field?: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "invalid_body" };
  }
  const r = raw as Record<string, unknown>;
  const inputMint = r["input_mint"];
  const outputMint = r["output_mint"];
  const amountRaw = r["input_amount"];
  const slippageRaw = r["slippage_bps"];

  if (typeof inputMint !== "string") {
    return { ok: false, error: "missing_input_mint", field: "input_mint" };
  }
  if (typeof outputMint !== "string") {
    return { ok: false, error: "missing_output_mint", field: "output_mint" };
  }
  if (inputMint !== USDC_MINT) {
    return { ok: false, error: "input_must_be_usdc", field: "input_mint" };
  }
  if (outputMint === inputMint) {
    return { ok: false, error: "output_equals_input", field: "output_mint" };
  }
  try {
    // Validate base58.
    new PublicKey(inputMint);
    new PublicKey(outputMint);
  } catch {
    return { ok: false, error: "invalid_mint_format" };
  }

  if (typeof amountRaw !== "string" && typeof amountRaw !== "number") {
    return { ok: false, error: "missing_input_amount", field: "input_amount" };
  }
  let amount: bigint;
  try {
    amount = BigInt(String(amountRaw));
  } catch {
    return { ok: false, error: "invalid_input_amount", field: "input_amount" };
  }
  if (amount <= 0n) {
    return { ok: false, error: "invalid_input_amount", field: "input_amount" };
  }
  if (amount > MAX_INPUT_USDC_ATOMIC) {
    return {
      ok: false,
      error: "input_amount_exceeds_max",
      field: "input_amount",
    };
  }

  const slippage = typeof slippageRaw === "number" ? slippageRaw : Number(slippageRaw);
  if (!Number.isFinite(slippage) || !Number.isInteger(slippage)) {
    return { ok: false, error: "invalid_slippage", field: "slippage_bps" };
  }
  if (slippage < MIN_SLIPPAGE_BPS || slippage > MAX_SLIPPAGE_BPS) {
    return { ok: false, error: "slippage_out_of_range", field: "slippage_bps" };
  }

  return {
    ok: true,
    req: { inputMint, outputMint, inputAmount: amount, slippageBps: slippage },
  };
}

/**
 * Service fee: 1% of input, rounded UP so we never undercharge.
 */
export function computeFee(inputAmount: bigint): bigint {
  return (inputAmount * FEE_BPS + 9999n) / 10000n;
}

// --------------------------------------------------------- public response ----

/**
 * Quote response shape. The breaking change from earlier versions is
 * `input_token` and `output_token` — previously raw mint strings, now
 * structured `TokenMetadataView` objects with symbol/name/decimals/
 * logoURI. The old string field names are aliased as
 * `input_token_mint` / `output_token_mint` so older clients can read
 * the mint address without breakage.
 */
export interface TokenMetadataView {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
}

export interface QuoteResponseShape {
  quote_id: string;
  input_token: TokenMetadataView;
  output_token: TokenMetadataView;
  /** Back-compat alias for `input_token.mint` (deprecated). */
  input_token_mint: string;
  /** Back-compat alias for `output_token.mint` (deprecated). */
  output_token_mint: string;
  input_amount: string;
  expected_output: string;
  expected_output_human: string;
  price_impact_pct: number;
  fee: string;
  fee_human: string;
  total_cost: string;
  total_cost_human: string;
  expires_at: string;
  x402_pay_url: string;
}

export interface BuildQuoteResponseArgs {
  quoteId: string;
  inputMeta: TokenMetadata;
  outputMeta: TokenMetadata;
  inputAmount: bigint;
  expectedOutput: bigint;
  fee: bigint;
  priceImpactPct: number;
  expiresAt: Date;
  publicBaseUrl: string;
}

export function buildQuoteResponse(
  args: BuildQuoteResponseArgs,
): QuoteResponseShape {
  const inputView = toView(args.inputMeta);
  const outputView = toView(args.outputMeta);
  return {
    quote_id: args.quoteId,
    input_token: inputView,
    output_token: outputView,
    input_token_mint: inputView.mint,
    output_token_mint: outputView.mint,
    input_amount: args.inputAmount.toString(),
    expected_output: args.expectedOutput.toString(),
    expected_output_human: formatTokenAmount(args.expectedOutput, args.outputMeta),
    price_impact_pct: args.priceImpactPct,
    fee: args.fee.toString(),
    fee_human: formatTokenAmount(args.fee, args.inputMeta),
    total_cost: (args.inputAmount + args.fee).toString(),
    total_cost_human: formatTokenAmount(args.inputAmount + args.fee, args.inputMeta),
    expires_at: args.expiresAt.toISOString(),
    x402_pay_url: `${args.publicBaseUrl}/v1/swap/solana/execute/${args.quoteId}`,
  };
}

function toView(meta: TokenMetadata): TokenMetadataView {
  return {
    mint: meta.mint,
    symbol: meta.symbol,
    name: meta.name,
    decimals: meta.decimals,
    ...(meta.logoURI ? { logoURI: meta.logoURI } : {}),
  };
}

/**
 * Parse the `priceImpactPct` field from a Jupiter quote response.
 * Jupiter sends a stringified decimal (e.g. "0.000026") on most
 * routes, but small-trade routes occasionally come back as a number
 * or empty. Normalize to a finite `number`, falling back to 0 for
 * anything weird so the response always carries a non-null value.
 */
export function parsePriceImpact(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 0;
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
  return Number.isFinite(n) ? n : 0;
}

// --------------------------------------------------------- execute pipeline ----

export interface ExecuteSwapArgs {
  quoteId: string;
  /** Buyer address (extracted from x402 receipt). MUST be Solana. */
  recipient: string;
  /** Settled inbound facilitator_payments.id, or null if missing. */
  inboundPaymentId: string | null;
  pool: Pool;
  chain: SolanaSwapChain;
  swapWalletAddress: string;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export type ExecuteSwapOutcome =
  | {
      kind: "ok";
      swapSignature: string;
      transferSignature: string;
      outputAmount: bigint;
    }
  | {
      kind: "expired";
    }
  | {
      kind: "already_taken";
    }
  | {
      kind: "slippage";
      detail: string;
    }
  | {
      kind: "failed";
      detail: string;
      refundRecorded: boolean;
    };

/**
 * Drive a swap row from `quoted` to `completed` (or `failed_*`).
 * Idempotent against the inbound payment id — the conditional
 * markExecuting update ensures only one caller wins the race.
 *
 * Refund handling: if we fail AFTER taking the buyer's payment, we
 * insert a `swap_refunds` row with status='pending'. We do NOT
 * broadcast an on-chain refund here — that's an operator workflow.
 */
export async function executeSolanaSwap(
  args: ExecuteSwapArgs,
): Promise<ExecuteSwapOutcome> {
  const swap = await findByQuoteId(args.pool, args.quoteId);
  if (swap === null) return { kind: "expired" };

  if (swap.status !== "quoted") {
    return swap.status === "completed"
      ? { kind: "already_taken" }
      : { kind: "expired" };
  }
  if (swap.expiresAt && swap.expiresAt.getTime() < Date.now()) {
    await markFailed(args.pool, {
      quoteId: args.quoteId,
      status: "expired",
      error: "quote_ttl_exceeded",
    });
    return { kind: "expired" };
  }

  // Try to claim the quote — atomic conditional UPDATE.
  const claimed = await markExecuting(args.pool, {
    quoteId: args.quoteId,
    recipientAddress: args.recipient,
    inboundPaymentId: args.inboundPaymentId,
  });
  if (!claimed) return { kind: "already_taken" };

  const expectedOutput = BigInt(swap.expectedOutput ?? "0");
  const inputAmount = BigInt(swap.inputAmount);
  const slippageBps = swap.slippageBps ?? MAX_SLIPPAGE_BPS;

  // Re-quote sanity check — Jupiter prices move quickly.
  let freshQuote: JupiterQuoteResponse;
  try {
    freshQuote = await fetchJupiterQuote({
      inputMint: swap.inputToken,
      outputMint: swap.outputToken,
      amount: inputAmount.toString(),
      slippageBps,
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    });
  } catch (err) {
    return await handleFailure(
      args,
      swap,
      "failed",
      `requote_failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const freshOut = BigInt(freshQuote.outAmount);
  // Drift = |fresh - cached| / cached, in basis points.
  if (expectedOutput > 0n) {
    const diff = freshOut > expectedOutput
      ? freshOut - expectedOutput
      : expectedOutput - freshOut;
    const driftBps = (diff * 10000n) / expectedOutput;
    if (driftBps > REQUOTE_DRIFT_BPS) {
      await markFailed(args.pool, {
        quoteId: args.quoteId,
        status: "failed_slippage",
        error: `requote_drift_bps_${driftBps}`,
      });
      const refundRecorded = await tryRecordRefund(
        args,
        swap,
        `requote_drift_bps=${driftBps}`,
      );
      args.logger?.warn?.(
        `swap: requote drift exceeded quote=${args.quoteId} drift_bps=${driftBps}`,
      );
      return {
        kind: "slippage",
        detail: `requote_drift_bps=${driftBps}`,
        ...(refundRecorded ? {} : {}),
      };
    }
  }

  // Record swap wallet's output balance BEFORE the swap so we can
  // diff it after — Jupiter's `outAmount` is the route plan estimate,
  // not a guarantee. Use the wallet diff as ground truth.
  let preBalance: bigint;
  try {
    preBalance = await args.chain.readSwapWalletBalance(swap.outputToken);
  } catch (err) {
    return await handleFailure(
      args,
      swap,
      "failed",
      `pre_balance_read_failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Ask Jupiter to build the signed-ready transaction.
  let swapTxB64: string;
  try {
    const swapResp = await fetchJupiterSwap({
      quoteResponse: freshQuote,
      userPublicKey: args.swapWalletAddress,
      wrapAndUnwrapSol: true,
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    });
    swapTxB64 = swapResp.swapTransaction;
  } catch (err) {
    return await handleFailure(
      args,
      swap,
      "failed",
      err instanceof JupiterError
        ? err.code
        : `jupiter_swap_failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Sign, send, confirm.
  let swapSignature: string;
  try {
    const r = await args.chain.signAndSendVersionedSwap({
      swapTransactionB64: swapTxB64,
    });
    swapSignature = r.signature;
  } catch (err) {
    return await handleFailure(
      args,
      swap,
      "failed",
      `swap_send_failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Verify the swap actually credited the expected output.
  let postBalance: bigint;
  try {
    postBalance = await args.chain.readSwapWalletBalance(swap.outputToken);
  } catch (err) {
    return await handleFailure(
      args,
      swap,
      "failed",
      `post_balance_read_failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const delivered = postBalance > preBalance ? postBalance - preBalance : 0n;

  // Floor for `delivered` — must clear the buyer-declared slippage
  // threshold. otherAmountThreshold from Jupiter encodes the
  // minimum-out for the chosen slippage; honor it directly.
  const minOut = BigInt(freshQuote.otherAmountThreshold);
  if (delivered < minOut) {
    return await handleFailure(
      args,
      swap,
      "failed_slippage",
      `delivered_${delivered}_lt_min_${minOut}`,
    );
  }

  // Transfer to the buyer's recipient.
  let transferSignature: string;
  try {
    const r = await args.chain.transferOutput({
      mint: swap.outputToken,
      amount: delivered,
      recipient: args.recipient,
    });
    transferSignature = r.signature;
  } catch (err) {
    return await handleFailure(
      args,
      swap,
      "failed",
      `transfer_failed: ${err instanceof Error ? err.message : String(err)} swap_sig=${swapSignature}`,
    );
  }

  await markCompleted(args.pool, {
    quoteId: args.quoteId,
    actualOutput: delivered.toString(),
    swapTxHash: swapSignature,
  });

  args.logger?.info?.(
    `swap: completed quote=${args.quoteId} swap_sig=${swapSignature} ` +
      `transfer_sig=${transferSignature} delivered=${delivered}`,
  );

  return {
    kind: "ok",
    swapSignature,
    transferSignature,
    outputAmount: delivered,
  };
}

async function handleFailure(
  args: ExecuteSwapArgs,
  swap: SwapRow,
  status: "failed" | "failed_slippage",
  detail: string,
): Promise<ExecuteSwapOutcome> {
  await markFailed(args.pool, {
    quoteId: args.quoteId,
    status,
    error: detail,
  });
  const refundRecorded = await tryRecordRefund(args, swap, detail);
  args.logger?.error?.(
    `swap: failed quote=${args.quoteId} status=${status} detail=${detail} ` +
      `refund_recorded=${refundRecorded}`,
  );
  if (status === "failed_slippage") {
    return { kind: "slippage", detail };
  }
  return { kind: "failed", detail, refundRecorded };
}

async function tryRecordRefund(
  args: ExecuteSwapArgs,
  swap: SwapRow,
  reason: string,
): Promise<boolean> {
  try {
    await recordRefund(args.pool, {
      swapId: swap.id,
      buyerAddress: args.recipient,
      network: swap.network,
      amount: (BigInt(swap.inputAmount) + BigInt(swap.feeAmount ?? "0")).toString(),
      reason,
    });
    return true;
  } catch (err) {
    args.logger?.error?.(
      `swap: refund record failed quote=${args.quoteId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

// ---------------------------------------------------------------- routes ----

export interface RegisterSwapRoutesDeps {
  pool: Pool;
  facilitatorUrl: string;
  facilitatorApiKey: string;
  swapSigner: SwapSignerConfig;
  chain: SolanaSwapChain;
  /** Base URL used to build the x402_pay_url returned by /quote. */
  publicBaseUrl: string;
  fetchImpl?: typeof fetch;
}

/**
 * Register the swap routes on the given Fastify instance. Should be
 * called BEFORE the catch-all rate-limited routes so the swap routes
 * don't fall through them.
 */
export function registerSwapRoutes(
  app: FastifyInstance,
  deps: RegisterSwapRoutesDeps,
): void {
  const fetchImpl = deps.fetchImpl ?? fetch;

  // --- POST /v1/swap/solana/quote -----------------------------------------
  app.route({
    method: "POST",
    url: "/v1/swap/solana/quote",
    handler: async (req, reply) => {
      const raw = parseJsonBody(req.body);
      if (raw === null) {
        return reply.code(400).send({ error: "invalid_json_body" });
      }
      const validated = validateQuoteInput(raw);
      if (!validated.ok) {
        const body: Record<string, unknown> = { error: validated.error };
        if (validated.field) body["field"] = validated.field;
        return reply.code(400).send(body);
      }
      const { req: vreq } = validated;
      let quote: JupiterQuoteResponse;
      try {
        quote = await fetchJupiterQuote({
          inputMint: vreq.inputMint,
          outputMint: vreq.outputMint,
          amount: vreq.inputAmount.toString(),
          slippageBps: vreq.slippageBps,
          fetchImpl,
        });
      } catch (err) {
        req.log.warn(
          { err },
          `swap: quote upstream failed input=${vreq.inputAmount} out=${vreq.outputMint}`,
        );
        if (err instanceof JupiterError) {
          return reply
            .code(err.upstreamStatus >= 500 ? 502 : 400)
            .send({ error: err.code, detail: err.excerpt });
        }
        return reply.code(502).send({ error: "jupiter_unreachable" });
      }

      const expectedOutput = BigInt(quote.outAmount);
      const fee = computeFee(vreq.inputAmount);
      const quoteId = `q_${randomUUID().replace(/-/g, "")}`;
      const expiresAt = new Date(Date.now() + QUOTE_TTL_SECONDS * 1000);

      try {
        await insertQuote(deps.pool, {
          quoteId,
          network: SOLANA_CAIP2,
          inputToken: vreq.inputMint,
          outputToken: vreq.outputMint,
          inputAmount: vreq.inputAmount.toString(),
          expectedOutput: expectedOutput.toString(),
          slippageBps: vreq.slippageBps,
          feeAmount: fee.toString(),
          expiresAt,
          jupiterQuote: quote,
        });
      } catch (err) {
        req.log.error({ err }, "swap: insert quote row failed");
        return reply.code(500).send({ error: "store_unavailable" });
      }

      // Resolve token metadata for both legs. The resolver never
      // throws and never returns null — worst case yields an UNKNOWN
      // stub so the response shape stays stable.
      const heliusApiKey = process.env["HELIUS_API_KEY"];
      const metaOpts = {
        fetchImpl,
        ...(heliusApiKey ? { heliusApiKey } : {}),
      };
      const [inputMeta, outputMeta] = await Promise.all([
        getTokenMetadata(vreq.inputMint, metaOpts),
        getTokenMetadata(vreq.outputMint, metaOpts),
      ]);

      return reply.code(200).send(
        buildQuoteResponse({
          quoteId,
          inputMeta,
          outputMeta,
          inputAmount: vreq.inputAmount,
          expectedOutput,
          fee,
          priceImpactPct: parsePriceImpact(quote.priceImpactPct),
          expiresAt,
          publicBaseUrl: deps.publicBaseUrl,
        }),
      );
    },
  });

  // --- POST /v1/swap/solana/execute/:quoteId ------------------------------
  app.route({
    method: "POST",
    url: "/v1/swap/solana/execute/:quoteId",
    handler: async (req, reply) => {
      const { quoteId } = req.params as { quoteId: string };
      const swap = await findByQuoteId(deps.pool, quoteId);
      if (swap === null) {
        return reply.code(404).send({ error: "unknown_quote_id" });
      }
      if (swap.status === "completed") {
        return reply.code(409).send({
          error: "quote_already_completed",
          swap_tx: swap.swapTxHash,
          recipient: swap.recipientAddress,
          output_amount: swap.actualOutput,
        });
      }
      if (swap.status !== "quoted") {
        return reply.code(409).send({
          error: `quote_status_${swap.status}`,
        });
      }
      if (swap.expiresAt && swap.expiresAt.getTime() < Date.now()) {
        await markFailed(deps.pool, {
          quoteId,
          status: "expired",
          error: "quote_ttl_exceeded",
        });
        return reply.code(410).send({ error: "quote_expired" });
      }

      // Build the x402 challenge dynamically from this quote's price.
      const total = BigInt(swap.inputAmount) + BigInt(swap.feeAmount ?? "0");
      const accepted: AcceptedPayment[] = [
        {
          scheme: "exact",
          network: SOLANA_CAIP2,
          asset: USDC_MINT,
          payTo: deps.swapSigner.address,
          maxAmountRequired: total.toString(),
        },
      ];

      const headers = req.headers as Record<string, string | string[] | undefined>;
      const paymentHeader = pickHeader(headers, "payment-signature") ??
        pickHeader(headers, "x-payment");
      const idempotencyKey = pickHeader(headers, "idempotency-key");
      const resourceUrl = `${deps.publicBaseUrl}/v1/swap/solana/execute/${quoteId}`;

      const middlewareOpts: MiddlewareOptions = {
        apiKey: deps.facilitatorApiKey,
        facilitator: deps.facilitatorUrl,
        acceptedPayments: accepted,
        description: `SuVerse Solana Swap → ${swap.outputToken}`,
        x402Version: 2,
        settle: true,
        fetchImpl,
        logger: req.log as unknown as MiddlewareOptions["logger"],
      };

      const protocol = await runProtocol({
        opts: middlewareOpts,
        resourceUrl,
        paymentHeader,
        idempotencyKey,
      });
      if (protocol.kind !== "accepted") {
        return reply
          .code(protocol.status)
          .header("content-type", "application/json")
          .header("cache-control", "no-store")
          .header(
            "payment-required",
            Buffer.from(JSON.stringify(protocol.body)).toString("base64"),
          )
          .send(protocol.body);
      }

      const receipt = protocol.receipt;
      // Validate that the payer is a Solana base58 pubkey — anything
      // else is rejected before we touch chain.
      try {
        new PublicKey(receipt.payer);
      } catch {
        await markFailed(deps.pool, {
          quoteId,
          status: "failed",
          error: `non_solana_payer:${receipt.payer.slice(0, 16)}`,
        });
        return reply.code(400).send({
          error: "recipient_not_solana",
          detail: "swap output requires a Solana payer address",
        });
      }

      const outcome = await executeSolanaSwap({
        quoteId,
        recipient: receipt.payer,
        inboundPaymentId: null,
        pool: deps.pool,
        chain: deps.chain,
        swapWalletAddress: deps.swapSigner.address,
        fetchImpl,
        logger: req.log as unknown as Console,
      });

      const paymentResponse = Buffer.from(
        JSON.stringify({
          success: outcome.kind === "ok",
          transaction: receipt.txHash ?? "",
          network: receipt.network,
          payer: receipt.payer,
          amount: receipt.amount,
        }),
      ).toString("base64");

      const replyHeaders: Record<string, string> = {
        "content-type": "application/json",
        "payment-response": paymentResponse,
        "x-payment-response": paymentResponse,
        "access-control-expose-headers":
          "PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
      };

      if (outcome.kind === "ok") {
        return reply
          .code(200)
          .headers(replyHeaders)
          .send({
            status: "completed",
            quote_id: quoteId,
            swap_tx: outcome.swapSignature,
            transfer_tx: outcome.transferSignature,
            output_token: swap.outputToken,
            output_amount: outcome.outputAmount.toString(),
            recipient: receipt.payer,
          });
      }
      if (outcome.kind === "already_taken") {
        return reply.code(409).headers(replyHeaders).send({
          error: "quote_already_completed",
        });
      }
      if (outcome.kind === "expired") {
        return reply.code(410).headers(replyHeaders).send({
          error: "quote_expired",
        });
      }
      if (outcome.kind === "slippage") {
        return reply.code(503).headers(replyHeaders).send({
          error: "slippage_exceeded",
          detail: outcome.detail,
          refund_pending: true,
        });
      }
      return reply.code(502).headers(replyHeaders).send({
        error: "swap_failed",
        detail: outcome.detail,
        refund_pending: outcome.refundRecorded,
      });
    },
  });
}

// ---------------------------------------------------------- tiny helpers ----

function parseJsonBody(body: unknown): unknown {
  if (body === null || body === undefined) return null;
  if (Buffer.isBuffer(body)) {
    if (body.length === 0) return null;
    try {
      return JSON.parse(body.toString("utf8"));
    } catch {
      return null;
    }
  }
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (typeof body === "object") return body;
  return null;
}

function pickHeader(
  h: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = h[name];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}
