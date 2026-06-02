/**
 * SuVerse Base (eip155:8453) ERC20 swap — paid via x402, routed via
 * LiFi aggregator.
 *
 * Mirrors `swap.ts` (Solana / Jupiter) one-for-one but EVM-flavoured.
 * Two routes:
 *
 *   POST /v1/swap/base/quote         — FREE
 *   POST /v1/swap/base/execute/:id   — x402-paid (dynamic price)
 *
 * On-chain orchestration: the proxy holds a dedicated liquidity wallet
 * (`SWAP_BASE_ADDRESS`) separate from the upstream service wallet. It
 *   1. holds USDC for swap input,
 *   2. ensures LiFi's diamond contract has an ERC20 allowance over USDC,
 *   3. signs + broadcasts the LiFi-built swap transaction (output
 *      lands in the swap wallet itself),
 *   4. transfers the output ERC20 to the buyer's payer address.
 *
 * Why three on-chain txs (approve + swap + transfer) instead of two
 * (one-shot LiFi swap with toAddress = buyer):
 *   - Symmetry with the Solana swap (validate output via balance diff
 *     before forwarding).
 *   - One approval amortises across many swaps — we only re-approve
 *     when allowance drops below the input amount.
 *   - The output transfer is a trivial ERC20.transfer; isolating it
 *     keeps refund accounting clean if the LiFi route succeeds but the
 *     forward fails.
 *
 * Refunds: this v1 records a row in `swap_refunds` (status='pending')
 * but does NOT broadcast an on-chain refund — same as the Solana flow.
 *
 * Test surface: `executeBaseSwap()` and helpers are exported so a
 * vitest suite can drive the orchestration without booting Fastify or
 * touching Base mainnet (`BaseSwapChain` is injected).
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { runProtocol } from "@suverselabs/x402-server";
import type {
  AcceptedPayment,
  MiddlewareOptions,
} from "@suverselabs/x402-server";
import {
  fetchLifiQuote,
  LifiError,
  type LifiQuoteResponse,
} from "./swap-lifi.js";
import {
  buildGasGuardQuoteFields,
  evaluateBaseSwapGas,
  type BaseGasProbe,
  type GasGuardOk,
} from "./swap-gas-guard.js";
import {
  findByQuoteId,
  insertQuote,
  markCompleted,
  markExecuting,
  markFailed,
  recordRefund,
  type SwapRow,
} from "./swap-store.js";
import { getBaseTokenMetadata } from "./lib/base-token-metadata.js";
import {
  formatTokenAmount,
  type TokenMetadata,
} from "./lib/token-metadata.js";

// ---------------------------------------------------------------- consts ----

/** USDC contract on Base mainnet (Circle native, 6 decimals). */
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
/** CAIP-2 for Base mainnet. */
export const BASE_CAIP2 = "eip155:8453";
/** EIP-155 chain id for LiFi quote requests. */
export const BASE_CHAIN_ID = 8453;

/** Max swappable input in USDC atomic units (6 decimals → 50e6 = $50). */
export const MAX_INPUT_USDC_ATOMIC = 50_000_000n;
/** Service fee in basis points (1%). */
export const FEE_BPS = 100n;
/** Slippage tolerance bounds — buyers can ask anywhere in [10, 500] bps. */
export const MIN_SLIPPAGE_BPS = 10;
export const MAX_SLIPPAGE_BPS = 500;
/** A quote is honored for this long after creation. */
export const QUOTE_TTL_SECONDS = 60;
/**
 * Drift threshold between cached and fresh quote at execute time.
 * 200 bps = 2%. Exceeding it short-circuits to a refund-pending state.
 */
export const REQUOTE_DRIFT_BPS = 200n;
/** Max wait for a single Base tx to confirm before we declare failure. */
export const CONFIRM_TIMEOUT_MS = 60_000;
/**
 * Allowance top-up size. When the LiFi spender's allowance over USDC
 * falls below the input amount, we approve this much in one go so
 * subsequent swaps amortise. Picked at 1000 USDC so that even at the
 * $50/swap cap we get ~20 swaps per approval, but small enough that
 * if the swap wallet is ever compromised the blast radius is bounded.
 */
export const ALLOWANCE_TOPUP = 1_000_000_000n; // 1000 USDC atomic

/** Minimal ERC20 ABI — only the calls we need. */
const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// --------------------------------------------------------------- env load ----

export interface BaseSwapSignerConfig {
  /** EIP-55 checksum address. */
  address: Address;
  /** Hex-encoded 32-byte private key (`0x...`). */
  privateKey: Hex;
}

/**
 * Read the dedicated Base swap liquidity wallet from env. Returns
 * `undefined` if either var is absent — caller can then skip Base
 * swap route registration without crashing the proxy boot.
 */
export function loadBaseSwapSigner(
  env: NodeJS.ProcessEnv = process.env,
): BaseSwapSignerConfig | undefined {
  const addressRaw = env["SWAP_BASE_ADDRESS"];
  const path = env["SWAP_BASE_PRIVKEY_PATH"];
  if (!addressRaw || !path) return undefined;
  const raw = readFileSync(path, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      `SWAP_BASE_PRIVKEY_PATH at ${path} is not a 0x-prefixed 32-byte hex string`,
    );
  }
  const privateKey = raw as Hex;
  const derived = privateKeyToAccount(privateKey).address;
  // Compare in lowercase to tolerate any case mismatch between env
  // var and derived checksum form.
  if (derived.toLowerCase() !== addressRaw.toLowerCase()) {
    throw new Error(
      `SWAP_BASE_ADDRESS=${addressRaw} does not match keypair at ${path} (derived ${derived})`,
    );
  }
  return { address: derived, privateKey };
}

// ------------------------------------------------------- chain abstraction ----

/**
 * Base operations the swap orchestrator needs. Narrow seam so vitest
 * can stub it without spinning up a viem client. Production impl is
 * `ViemBaseSwapChain` below.
 */
export interface BaseSwapChain {
  /**
   * Read ERC20 balance of `token` held by the swap wallet. When
   * `opts.blockNumber` is supplied, the read is pinned to that exact
   * block — required after a freshly-confirmed tx so a load-balanced
   * RPC (e.g. mainnet.base.org) cannot return stale state from a
   * node that hasn't applied the block yet. Implementations should
   * retry transient errors (block-not-found / timeout) before giving
   * up; the executor relies on this read to detect false negatives.
   */
  readSwapWalletBalance(
    token: Address,
    opts?: { blockNumber?: bigint },
  ): Promise<bigint>;
  /**
   * Read ERC20 allowance the swap wallet has granted to `spender`
   * over `token`.
   */
  readAllowance(token: Address, spender: Address): Promise<bigint>;
  /**
   * ERC20.approve(spender, amount) signed by the swap wallet. Waits
   * for receipt; throws on revert.
   */
  approveERC20(args: {
    token: Address;
    spender: Address;
    amount: bigint;
  }): Promise<{ txHash: Hex }>;
  /**
   * Broadcast LiFi's prebuilt swap transaction (sign with swap wallet,
   * wait for receipt). Returns the txHash AND the receipt's
   * blockNumber so the caller can pin its post-balance read to the
   * exact block that included the swap. Throws on revert or timeout.
   */
  sendSwapTx(args: {
    to: Address;
    data: Hex;
    value: bigint;
    gasLimit?: bigint;
    gasPrice?: bigint;
  }): Promise<{ txHash: Hex; blockNumber: bigint }>;
  /**
   * ERC20.transfer(to, amount) signed by the swap wallet.
   */
  transferERC20(args: {
    token: Address;
    to: Address;
    amount: bigint;
  }): Promise<{ txHash: Hex }>;
}

/**
 * Production implementation backed by viem against a Base RPC.
 * `rpcUrl` defaults to https://mainnet.base.org (Coinbase's public
 * endpoint) but can be overridden via BASE_RPC_URL for paid/reliable
 * RPC providers (Alchemy, QuickNode, etc.).
 */
export class ViemBaseSwapChain implements BaseSwapChain {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly account: Account;
  private readonly chain: Chain;

  constructor(args: { rpcUrl: string; privateKey: Hex }) {
    this.account = privateKeyToAccount(args.privateKey);
    this.chain = base;
    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: http(args.rpcUrl),
    });
    this.walletClient = createWalletClient({
      chain: this.chain,
      account: this.account,
      transport: http(args.rpcUrl),
    });
  }

  async readSwapWalletBalance(
    token: Address,
    opts?: { blockNumber?: bigint },
  ): Promise<bigint> {
    // mainnet.base.org is a public load balancer. A read pinned to a
    // freshly-mined block can hit a node that hasn't applied it yet
    // and throw "block not found"; an unpinned "latest" read can land
    // on a node a slot behind and silently return pre-tx state. Both
    // failure modes have produced orphaned post-swap WETH in
    // production (refund rows 4e4691cd, 6b8b3243). Retry on ANY error
    // up to ~7s — long enough to outlast a typical lagging-node
    // window. When opts.blockNumber is supplied we always pin (caller
    // is responsible for passing the swap's inclusion block).
    const delaysMs = [500, 1000, 1000, 1500, 1500, 1500];
    let lastErr: unknown;
    for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
      try {
        return (await this.publicClient.readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [this.account.address],
          ...(opts?.blockNumber !== undefined
            ? { blockNumber: opts.blockNumber }
            : {}),
        })) as bigint;
      } catch (err) {
        lastErr = err;
        if (attempt < delaysMs.length) {
          await new Promise((r) => setTimeout(r, delaysMs[attempt]));
        }
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`balance read failed: ${String(lastErr)}`);
  }

  async readAllowance(token: Address, spender: Address): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [this.account.address, spender],
    })) as bigint;
  }

  async approveERC20(args: {
    token: Address;
    spender: Address;
    amount: bigint;
  }): Promise<{ txHash: Hex }> {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [args.spender, args.amount],
    });
    const txHash = await this.walletClient.sendTransaction({
      account: this.account,
      chain: this.chain,
      to: args.token,
      data,
      value: 0n,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: CONFIRM_TIMEOUT_MS,
    });
    if (receipt.status !== "success") {
      throw new Error(`approve_reverted: ${txHash}`);
    }
    return { txHash };
  }

  async sendSwapTx(args: {
    to: Address;
    data: Hex;
    value: bigint;
    gasLimit?: bigint;
    gasPrice?: bigint;
  }): Promise<{ txHash: Hex; blockNumber: bigint }> {
    // viem's sendTransaction picks gas fee fields automatically if we
    // omit them. LiFi gives us a hint (`gasPrice`) but EIP-1559 on
    // Base means letting viem use maxFeePerGas/maxPriorityFeePerGas
    // is usually more reliable than echoing back a 60s-old gas hint.
    const txHash = await this.walletClient.sendTransaction({
      account: this.account,
      chain: this.chain,
      to: args.to,
      data: args.data,
      value: args.value,
      ...(args.gasLimit !== undefined ? { gas: args.gasLimit } : {}),
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: CONFIRM_TIMEOUT_MS,
    });
    if (receipt.status !== "success") {
      throw new Error(`swap_tx_reverted: ${txHash}`);
    }
    return { txHash, blockNumber: receipt.blockNumber };
  }

  async transferERC20(args: {
    token: Address;
    to: Address;
    amount: bigint;
  }): Promise<{ txHash: Hex }> {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [args.to, args.amount],
    });
    const txHash = await this.walletClient.sendTransaction({
      account: this.account,
      chain: this.chain,
      to: args.token,
      data,
      value: 0n,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: CONFIRM_TIMEOUT_MS,
    });
    if (receipt.status !== "success") {
      throw new Error(`transfer_reverted: ${txHash}`);
    }
    return { txHash };
  }
}

// --------------------------------------------------------- shared quoting ----

export type SwapDirection = "forward" | "reverse";

export interface ValidatedBaseQuoteRequest {
  inputToken: Address;
  outputToken: Address;
  inputAmount: bigint;
  slippageBps: number;
  /** Forward = USDC-in (existing flow). Reverse = USDC-out via approval+pull. */
  direction: SwapDirection;
}

/**
 * Validate and normalise the /quote input. Constraints:
 *   - Exactly one of {input_token, output_token} MUST be USDC on Base.
 *   - output_token MUST NOT equal input_token.
 *   - Both addresses must be valid EIP-55.
 *   - input_amount > 0 atomic.
 *   - Forward direction caps input at MAX_INPUT_USDC_ATOMIC pre-quote;
 *     reverse direction can't (USD value isn't known until Jupiter/LiFi
 *     re-quotes), so the route handler enforces it on expected_output.
 *   - slippage_bps in [MIN, MAX].
 */
export function validateBaseQuoteInput(raw: unknown):
  | { ok: true; req: ValidatedBaseQuoteRequest }
  | { ok: false; error: string; field?: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "invalid_body" };
  }
  const r = raw as Record<string, unknown>;
  const inputTokenRaw = r["input_token"];
  const outputTokenRaw = r["output_token"];
  const amountRaw = r["input_amount"];
  const slippageRaw = r["slippage_bps"];

  if (typeof inputTokenRaw !== "string") {
    return { ok: false, error: "missing_input_token", field: "input_token" };
  }
  if (typeof outputTokenRaw !== "string") {
    return { ok: false, error: "missing_output_token", field: "output_token" };
  }
  if (!isAddress(inputTokenRaw) || !isAddress(outputTokenRaw)) {
    return { ok: false, error: "invalid_token_format" };
  }
  const inputToken = getAddress(inputTokenRaw);
  const outputToken = getAddress(outputTokenRaw);
  if (inputToken.toLowerCase() === outputToken.toLowerCase()) {
    return { ok: false, error: "output_equals_input", field: "output_token" };
  }
  const inputIsUsdc =
    inputToken.toLowerCase() === USDC_BASE.toLowerCase();
  const outputIsUsdc =
    outputToken.toLowerCase() === USDC_BASE.toLowerCase();
  if (!inputIsUsdc && !outputIsUsdc) {
    return { ok: false, error: "one_side_must_be_usdc" };
  }
  const direction: SwapDirection = inputIsUsdc ? "forward" : "reverse";

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
  if (direction === "forward" && amount > MAX_INPUT_USDC_ATOMIC) {
    return {
      ok: false,
      error: "input_amount_exceeds_max",
      field: "input_amount",
    };
  }

  const slippage =
    typeof slippageRaw === "number" ? slippageRaw : Number(slippageRaw);
  if (!Number.isFinite(slippage) || !Number.isInteger(slippage)) {
    return { ok: false, error: "invalid_slippage", field: "slippage_bps" };
  }
  if (slippage < MIN_SLIPPAGE_BPS || slippage > MAX_SLIPPAGE_BPS) {
    return { ok: false, error: "slippage_out_of_range", field: "slippage_bps" };
  }

  return {
    ok: true,
    req: { inputToken, outputToken, inputAmount: amount, slippageBps: slippage, direction },
  };
}

/** Service fee: 1% of input, rounded UP so we never undercharge. */
export function computeFee(inputAmount: bigint): bigint {
  return (inputAmount * FEE_BPS + 9999n) / 10000n;
}

// --------------------------------------------------------- public response ----

export interface BaseTokenMetadataView {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
}

export interface BaseQuoteResponseShape {
  quote_id: string;
  input_token: BaseTokenMetadataView;
  output_token: BaseTokenMetadataView;
  /** Back-compat alias for `input_token.mint` (deprecated). */
  input_token_mint: string;
  /** Back-compat alias for `output_token.mint` (deprecated). */
  output_token_mint: string;
  input_amount: string;
  expected_output: string;
  expected_output_human: string;
  /** Aggregator route tag, e.g. "sushiswap", "uniswap-v3". Informational. */
  tool: string;
  fee: string;
  fee_human: string;
  total_cost: string;
  total_cost_human: string;
  expires_at: string;
  x402_pay_url: string;
  /**
   * USD estimate for the executor's combined approve+swap+transfer
   * gas cost on Base.
   */
  estimated_gas_cost_usd?: number;
  /**
   * Token-and-router-specific minimum input (USDC atomic, 6 dp) the
   * gas-cost guard derived for this quote. Above the absolute $1
   * floor only when the LiFi router has no USDC allowance from the
   * liquidity wallet yet.
   */
  minimum_input_atomic?: string;
  /**
   * Human-readable warning surfaced when the floor was bumped above
   * the absolute default — e.g. "LiFi router has no USDC allowance
   * from the liquidity wallet yet…". Absent on the cheapest path.
   */
  gas_warning?: string;
  /**
   * "forward" = USDC → ERC20 (the original flow; total_cost paid in
   * USDC via x402).
   * "reverse" = ERC20 → USDC; total_cost is ONLY the service fee in
   * USDC. The input ERC20 is pulled from the buyer's wallet via a
   * previously-set allowance — see requires_approval.
   */
  direction: SwapDirection;
  /**
   * True for reverse swaps — the buyer must call
   * `ERC20(input_token).approve(approval_target, input_amount)`
   * BEFORE /execute. False for forward swaps.
   */
  requires_approval: boolean;
  /**
   * For reverse swaps: the spender address the buyer must grant ERC20
   * allowance to. Equal to the swap liquidity wallet
   * (SWAP_BASE_ADDRESS). Absent for forward swaps.
   */
  approval_target?: string;
}

export interface BuildBaseQuoteResponseArgs {
  quoteId: string;
  inputMeta: TokenMetadata;
  outputMeta: TokenMetadata;
  inputAmount: bigint;
  expectedOutput: bigint;
  fee: bigint;
  tool: string;
  expiresAt: Date;
  publicBaseUrl: string;
  /** Direction the quote covers. */
  direction: SwapDirection;
  /**
   * For reverse quotes — the swap liquidity wallet address that must
   * be granted ERC20 allowance before /execute. Ignored when
   * direction === "forward".
   */
  approvalTarget?: string;
  /**
   * Gas-cost guard result. When supplied, the response includes
   * estimated_gas_cost_usd / minimum_input_atomic / gas_warning.
   * Optional so old callers don't need to thread the guard through.
   */
  gasGuard?: GasGuardOk;
}

export function buildBaseQuoteResponse(
  args: BuildBaseQuoteResponseArgs,
): BaseQuoteResponseShape {
  const inputView = toView(args.inputMeta);
  const outputView = toView(args.outputMeta);
  // x402 always settles in USDC. Forward: input+fee in input USDC.
  // Reverse: fee only — input ERC20 is pulled via allowance, gross
  // USDC goes to buyer.
  const totalCost =
    args.direction === "forward"
      ? args.inputAmount + args.fee
      : args.fee;
  const usdcMeta = args.direction === "forward" ? args.inputMeta : forceUsdcMeta(args.outputMeta);
  const out: BaseQuoteResponseShape = {
    quote_id: args.quoteId,
    input_token: inputView,
    output_token: outputView,
    input_token_mint: inputView.mint,
    output_token_mint: outputView.mint,
    input_amount: args.inputAmount.toString(),
    expected_output: args.expectedOutput.toString(),
    expected_output_human: formatTokenAmount(args.expectedOutput, args.outputMeta),
    tool: args.tool,
    fee: args.fee.toString(),
    fee_human: formatTokenAmount(args.fee, usdcMeta),
    total_cost: totalCost.toString(),
    total_cost_human: formatTokenAmount(totalCost, usdcMeta),
    expires_at: args.expiresAt.toISOString(),
    x402_pay_url: `${args.publicBaseUrl}/v1/swap/base/execute/${args.quoteId}`,
    direction: args.direction,
    requires_approval: args.direction === "reverse",
  };
  if (args.direction === "reverse" && args.approvalTarget !== undefined) {
    out.approval_target = args.approvalTarget;
  }
  if (args.gasGuard !== undefined) {
    const fields = buildGasGuardQuoteFields(args.gasGuard);
    out.estimated_gas_cost_usd = fields.estimated_gas_cost_usd;
    out.minimum_input_atomic = fields.minimum_input_atomic;
    if (fields.warning !== undefined) out.gas_warning = fields.warning;
  }
  return out;
}

/**
 * Defensive: for reverse swaps the outputMeta is expected to be USDC
 * (validateBaseQuoteInput enforces this). If a future caller forgets,
 * still render fee/total_cost as USDC rather than UNKNOWN.
 */
function forceUsdcMeta(meta: TokenMetadata): TokenMetadata {
  if (meta.mint.toLowerCase() === USDC_BASE.toLowerCase()) return meta;
  return {
    mint: USDC_BASE,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
  };
}

function toView(meta: TokenMetadata): BaseTokenMetadataView {
  return {
    mint: meta.mint,
    symbol: meta.symbol,
    name: meta.name,
    decimals: meta.decimals,
    ...(meta.logoURI ? { logoURI: meta.logoURI } : {}),
  };
}

// --------------------------------------------------------- execute pipeline ----

export interface ExecuteBaseSwapArgs {
  quoteId: string;
  /** Buyer EVM address (extracted from x402 receipt). */
  recipient: Address;
  /** Settled inbound facilitator_payments.id, or null if missing. */
  inboundPaymentId: string | null;
  pool: Pool;
  chain: BaseSwapChain;
  swapWalletAddress: Address;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export type ExecuteBaseSwapOutcome =
  | {
      kind: "ok";
      approveTxHash: Hex | null;
      swapTxHash: Hex;
      transferTxHash: Hex;
      outputAmount: bigint;
      tool: string;
    }
  | { kind: "expired" }
  | { kind: "already_taken" }
  | {
      kind: "slippage";
      detail: string;
      /** Slippage-protected floor we needed to clear. */
      expectedMin: bigint;
      /** Actual delivered; 0n when the swap aborted before delivery. */
      actual: bigint;
      /** Buyer-declared slippage tolerance in basis points. */
      bpsTolerance: number;
    }
  | { kind: "failed"; detail: string; refundRecorded: boolean };

/**
 * Drive a swap row from `quoted` to `completed` (or `failed_*`).
 * Idempotent against the inbound payment id — the conditional
 * markExecuting update ensures only one caller wins the race.
 *
 * Refund handling: if we fail AFTER taking the buyer's payment, we
 * insert a `swap_refunds` row with status='pending'. We do NOT
 * broadcast an on-chain refund here — that's an operator workflow.
 */
export async function executeBaseSwap(
  args: ExecuteBaseSwapArgs,
): Promise<ExecuteBaseSwapOutcome> {
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

  // Atomic claim.
  const claimed = await markExecuting(args.pool, {
    quoteId: args.quoteId,
    recipientAddress: args.recipient,
    inboundPaymentId: args.inboundPaymentId,
  });
  if (!claimed) return { kind: "already_taken" };

  const expectedOutput = BigInt(swap.expectedOutput ?? "0");
  const inputAmount = BigInt(swap.inputAmount);
  const slippageBps = swap.slippageBps ?? MAX_SLIPPAGE_BPS;
  const inputToken = getAddress(swap.inputToken);
  const outputToken = getAddress(swap.outputToken);

  // Re-quote sanity check — Base AMM prices move quickly.
  let freshQuote: LifiQuoteResponse;
  try {
    freshQuote = await fetchLifiQuote({
      chainId: BASE_CHAIN_ID,
      fromToken: inputToken,
      toToken: outputToken,
      fromAmount: inputAmount.toString(),
      fromAddress: args.swapWalletAddress,
      slippage: slippageBps / 10000,
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    });
  } catch (err) {
    return await handleFailure(
      args,
      swap,
      "failed",
      `requote_failed: ${err instanceof LifiError ? err.code : (err as Error).message}`,
    );
  }

  const freshOut = BigInt(freshQuote.estimate.toAmount);
  if (expectedOutput > 0n) {
    const diff =
      freshOut > expectedOutput ? freshOut - expectedOutput : expectedOutput - freshOut;
    const driftBps = (diff * 10000n) / expectedOutput;
    if (driftBps > REQUOTE_DRIFT_BPS) {
      await markFailed(args.pool, {
        quoteId: args.quoteId,
        status: "failed_slippage",
        error: `requote_drift_bps_${driftBps}`,
      });
      await tryRecordRefund(args, swap, `requote_drift_bps=${driftBps}`);
      args.logger?.warn?.(
        `swap-base: requote drift exceeded quote=${args.quoteId} drift_bps=${driftBps}`,
      );
      const expectedMin =
        (expectedOutput * BigInt(10000 - slippageBps)) / 10000n;
      return {
        kind: "slippage",
        detail: `requote_drift_bps=${driftBps}`,
        expectedMin,
        actual: freshOut,
        bpsTolerance: slippageBps,
      };
    }
  }

  // Ensure ERC20 allowance for the LiFi router covers this swap's
  // input. Top up to ALLOWANCE_TOPUP so subsequent swaps amortise.
  const spender = getAddress(freshQuote.estimate.approvalAddress);
  let approveTxHash: Hex | null = null;
  try {
    const current = await args.chain.readAllowance(inputToken, spender);
    if (current < inputAmount) {
      const approveAmount =
        ALLOWANCE_TOPUP > inputAmount ? ALLOWANCE_TOPUP : inputAmount;
      const r = await args.chain.approveERC20({
        token: inputToken,
        spender,
        amount: approveAmount,
      });
      approveTxHash = r.txHash;
    }
  } catch (err) {
    return await handleFailure(
      args,
      swap,
      "failed",
      `approve_failed: ${(err as Error).message}`,
    );
  }

  // Record output balance BEFORE the swap so we can diff after — the
  // quote `toAmount` is an estimate, not a guarantee.
  let preBalance: bigint;
  try {
    preBalance = await args.chain.readSwapWalletBalance(outputToken);
  } catch (err) {
    return await handleFailure(
      args,
      swap,
      "failed",
      `pre_balance_read_failed: ${(err as Error).message}`,
    );
  }

  // Broadcast the LiFi-built swap transaction.
  let swapTxHash: Hex;
  let swapBlockNumber: bigint;
  try {
    const txReq = freshQuote.transactionRequest;
    const r = await args.chain.sendSwapTx({
      to: getAddress(txReq.to),
      data: txReq.data as Hex,
      value: BigInt(txReq.value || "0x0"),
      ...(txReq.gasLimit ? { gasLimit: BigInt(txReq.gasLimit) } : {}),
      ...(txReq.gasPrice ? { gasPrice: BigInt(txReq.gasPrice) } : {}),
    });
    swapTxHash = r.txHash;
    swapBlockNumber = r.blockNumber;
  } catch (err) {
    return await handleFailure(
      args,
      swap,
      "failed",
      `swap_send_failed: ${(err as Error).message}`,
    );
  }

  // Verify the swap actually credited the expected output. Pin the
  // read to the swap's inclusion block — mainnet.base.org is a load
  // balancer, and a follow-up `latest` read can otherwise hit a node
  // a slot behind and return the pre-swap balance (false negative
  // that orphaned WETH twice in production — refunds 4e4691cd and
  // 6b8b3243). The retry inside ViemBaseSwapChain handles the dual
  // case where the pinned read hits a node that hasn't applied the
  // block yet.
  let postBalance: bigint;
  try {
    postBalance = await args.chain.readSwapWalletBalance(outputToken, {
      blockNumber: swapBlockNumber,
    });
  } catch (err) {
    return await handleFailure(
      args,
      swap,
      "failed",
      `post_balance_read_failed: ${(err as Error).message}`,
    );
  }
  const delivered = postBalance > preBalance ? postBalance - preBalance : 0n;

  const minOut = BigInt(freshQuote.estimate.toAmountMin);
  if (delivered < minOut) {
    return await handleSlippageFailure(args, swap, {
      detail: `delivered_${delivered}_lt_min_${minOut}`,
      expectedMin: minOut,
      actual: delivered,
      bpsTolerance: slippageBps,
    });
  }

  // Forward output to buyer.
  let transferTxHash: Hex;
  try {
    const r = await args.chain.transferERC20({
      token: outputToken,
      to: args.recipient,
      amount: delivered,
    });
    transferTxHash = r.txHash;
  } catch (err) {
    return await handleFailure(
      args,
      swap,
      "failed",
      `transfer_failed: ${(err as Error).message} swap_tx=${swapTxHash}`,
    );
  }

  await markCompleted(args.pool, {
    quoteId: args.quoteId,
    actualOutput: delivered.toString(),
    swapTxHash,
  });

  args.logger?.info?.(
    `swap-base: completed quote=${args.quoteId} swap_tx=${swapTxHash} ` +
      `transfer_tx=${transferTxHash} delivered=${delivered}`,
  );

  return {
    kind: "ok",
    approveTxHash,
    swapTxHash,
    transferTxHash,
    outputAmount: delivered,
    tool: freshQuote.tool,
  };
}

async function handleFailure(
  args: ExecuteBaseSwapArgs,
  swap: SwapRow,
  status: "failed",
  detail: string,
): Promise<ExecuteBaseSwapOutcome> {
  await markFailed(args.pool, {
    quoteId: args.quoteId,
    status,
    error: detail,
  });
  const refundRecorded = await tryRecordRefund(args, swap, detail);
  args.logger?.error?.(
    `swap-base: failed quote=${args.quoteId} status=${status} detail=${detail} ` +
      `refund_recorded=${refundRecorded}`,
  );
  return { kind: "failed", detail, refundRecorded };
}

async function handleSlippageFailure(
  args: ExecuteBaseSwapArgs,
  swap: SwapRow,
  info: {
    detail: string;
    expectedMin: bigint;
    actual: bigint;
    bpsTolerance: number;
  },
): Promise<ExecuteBaseSwapOutcome> {
  await markFailed(args.pool, {
    quoteId: args.quoteId,
    status: "failed_slippage",
    error: info.detail,
  });
  const refundRecorded = await tryRecordRefund(args, swap, info.detail);
  args.logger?.warn?.(
    `swap-base: slippage quote=${args.quoteId} detail=${info.detail} ` +
      `expected_min=${info.expectedMin} actual=${info.actual} ` +
      `bps_tolerance=${info.bpsTolerance} refund_recorded=${refundRecorded}`,
  );
  return {
    kind: "slippage",
    detail: info.detail,
    expectedMin: info.expectedMin,
    actual: info.actual,
    bpsTolerance: info.bpsTolerance,
  };
}

async function tryRecordRefund(
  args: ExecuteBaseSwapArgs,
  swap: SwapRow,
  reason: string,
): Promise<boolean> {
  try {
    await recordRefund(args.pool, {
      swapId: swap.id,
      buyerAddress: args.recipient,
      network: swap.network,
      amount: (
        BigInt(swap.inputAmount) + BigInt(swap.feeAmount ?? "0")
      ).toString(),
      reason,
    });
    return true;
  } catch (err) {
    args.logger?.error?.(
      `swap-base: refund record failed quote=${args.quoteId}: ${(err as Error).message}`,
    );
    return false;
  }
}

// ---------------------------------------------------------------- routes ----

export interface RegisterBaseSwapRoutesDeps {
  pool: Pool;
  facilitatorUrl: string;
  facilitatorApiKey: string;
  swapSigner: BaseSwapSignerConfig;
  chain: BaseSwapChain;
  publicBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export function registerBaseSwapRoutes(
  app: FastifyInstance,
  deps: RegisterBaseSwapRoutesDeps,
): void {
  const fetchImpl = deps.fetchImpl ?? fetch;

  // --- POST /v1/swap/base/quote -------------------------------------------
  app.route({
    method: "POST",
    url: "/v1/swap/base/quote",
    handler: async (req, reply) => {
      const raw = parseJsonBody(req.body);
      if (raw === null) {
        return reply.code(400).send({ error: "invalid_json_body" });
      }
      const validated = validateBaseQuoteInput(raw);
      if (!validated.ok) {
        const body: Record<string, unknown> = { error: validated.error };
        if (validated.field) body["field"] = validated.field;
        return reply.code(400).send(body);
      }
      const vreq = validated.req;
      let quote: LifiQuoteResponse;
      try {
        quote = await fetchLifiQuote({
          chainId: BASE_CHAIN_ID,
          fromToken: vreq.inputToken,
          toToken: vreq.outputToken,
          fromAmount: vreq.inputAmount.toString(),
          fromAddress: deps.swapSigner.address,
          slippage: vreq.slippageBps / 10000,
          fetchImpl,
        });
      } catch (err) {
        req.log.warn(
          { err },
          `swap-base: quote upstream failed input=${vreq.inputAmount} out=${vreq.outputToken}`,
        );
        if (err instanceof LifiError) {
          return reply
            .code(err.upstreamStatus >= 500 ? 502 : 400)
            .send({ error: err.code, detail: err.excerpt });
        }
        return reply.code(502).send({ error: "lifi_unreachable" });
      }

      const expectedOutput = BigInt(quote.estimate.toAmount);
      if (vreq.direction === "reverse" && expectedOutput > MAX_INPUT_USDC_ATOMIC) {
        return reply.code(400).send({
          error: "expected_output_exceeds_max",
          detail: `Reverse swap output ${expectedOutput} > cap ${MAX_INPUT_USDC_ATOMIC} (USDC atomic).`,
        });
      }
      // Fee always in USDC. Forward: 1% of input USDC. Reverse: 1% of
      // expected_output USDC.
      const feeBase =
        vreq.direction === "forward" ? vreq.inputAmount : expectedOutput;
      const fee = computeFee(feeBase);
      const quoteId = `qb_${randomUUID().replace(/-/g, "")}`;
      const expiresAt = new Date(Date.now() + QUOTE_TTL_SECONDS * 1000);

      // Gas-cost guard. Forward: probe is "does swap wallet have USDC
      // allowance for the LiFi spender?" — if not, +$0.005 approve.
      // Reverse: probe is "does swap wallet have INPUT_TOKEN allowance
      // for the LiFi spender?" — same shape, different token. Both
      // probes fall closed on RPC failure.
      //
      // For reverse the guard's "inputAtomic" is the USDC side of the
      // trade (expected_output) so the USD-denominated minimum applies
      // apples-to-apples.
      const lifiSpender = getAddress(quote.estimate.approvalAddress);
      const guardInputAtomic =
        vreq.direction === "forward" ? vreq.inputAmount : expectedOutput;
      const guardInputToken =
        vreq.direction === "forward" ? vreq.inputToken : vreq.inputToken;
      const gasProbe: BaseGasProbe = {
        allowance: (token, spender) =>
          deps.chain.readAllowance(getAddress(token), getAddress(spender)),
      };
      const guard = await evaluateBaseSwapGas({
        inputAtomic: guardInputAtomic,
        inputToken: guardInputToken,
        lifiSpender,
        feeBps: FEE_BPS,
        probe: gasProbe,
      });
      if (!guard.ok) {
        req.log.info(
          `swap-base: quote_too_small dir=${vreq.direction} in=${vreq.inputAmount} ` +
            `min=${guard.minimumInputAtomic} gas_usd=${guard.estimatedGasCostUsd} ` +
            `out=${vreq.outputToken}`,
        );
        return reply.code(400).send({
          error: guard.reason,
          detail: guard.message,
          minimum_input_atomic: guard.minimumInputAtomic.toString(),
          estimated_gas_cost_usd: guard.estimatedGasCostUsd,
        });
      }

      try {
        await insertQuote(deps.pool, {
          quoteId,
          network: BASE_CAIP2,
          inputToken: vreq.inputToken,
          outputToken: vreq.outputToken,
          inputAmount: vreq.inputAmount.toString(),
          expectedOutput: expectedOutput.toString(),
          slippageBps: vreq.slippageBps,
          feeAmount: fee.toString(),
          expiresAt,
          jupiterQuote: quote,
        });
      } catch (err) {
        req.log.error({ err }, "swap-base: insert quote row failed");
        return reply.code(500).send({ error: "store_unavailable" });
      }

      // Resolve token metadata for both legs — hardcoded fast-path
      // for popular tokens + LiFi /v1/tokens fallback for the long
      // tail. Never throws; worst case yields an UNKNOWN stub.
      const [inputMeta, outputMeta] = await Promise.all([
        getBaseTokenMetadata(vreq.inputToken, { fetchImpl }),
        getBaseTokenMetadata(vreq.outputToken, { fetchImpl }),
      ]);

      return reply.code(200).send(
        buildBaseQuoteResponse({
          quoteId,
          inputMeta,
          outputMeta,
          inputAmount: vreq.inputAmount,
          expectedOutput,
          fee,
          tool: quote.tool,
          expiresAt,
          publicBaseUrl: deps.publicBaseUrl,
          direction: vreq.direction,
          ...(vreq.direction === "reverse"
            ? { approvalTarget: deps.swapSigner.address }
            : {}),
          gasGuard: guard,
        }),
      );
    },
  });

  // --- POST /v1/swap/base/execute/:quoteId --------------------------------
  app.route({
    method: "POST",
    url: "/v1/swap/base/execute/:quoteId",
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
        return reply.code(409).send({ error: `quote_status_${swap.status}` });
      }
      if (swap.expiresAt && swap.expiresAt.getTime() < Date.now()) {
        await markFailed(deps.pool, {
          quoteId,
          status: "expired",
          error: "quote_ttl_exceeded",
        });
        return reply.code(410).send({ error: "quote_expired" });
      }

      const total =
        BigInt(swap.inputAmount) + BigInt(swap.feeAmount ?? "0");
      const accepted: AcceptedPayment[] = [
        {
          scheme: "exact",
          network: BASE_CAIP2,
          asset: USDC_BASE,
          payTo: deps.swapSigner.address,
          maxAmountRequired: total.toString(),
          extra: { name: "USD Coin", version: "2" },
        },
      ];

      const headers = req.headers as Record<string, string | string[] | undefined>;
      const paymentHeader =
        pickHeader(headers, "payment-signature") ?? pickHeader(headers, "x-payment");
      const idempotencyKey = pickHeader(headers, "idempotency-key");
      const resourceUrl = `${deps.publicBaseUrl}/v1/swap/base/execute/${quoteId}`;

      const middlewareOpts: MiddlewareOptions = {
        apiKey: deps.facilitatorApiKey,
        facilitator: deps.facilitatorUrl,
        acceptedPayments: accepted,
        description: `SuVerse Base Swap → ${swap.outputToken}`,
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
      // Validate payer is a real EVM address before touching chain.
      if (!isAddress(receipt.payer)) {
        await markFailed(deps.pool, {
          quoteId,
          status: "failed",
          error: `non_evm_payer:${receipt.payer.slice(0, 16)}`,
        });
        return reply.code(400).send({
          error: "recipient_not_evm",
          detail: "swap output requires an EVM payer address",
        });
      }
      const recipient = getAddress(receipt.payer);

      const outcome = await executeBaseSwap({
        quoteId,
        recipient,
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
            approve_tx: outcome.approveTxHash,
            swap_tx: outcome.swapTxHash,
            transfer_tx: outcome.transferTxHash,
            output_token: swap.outputToken,
            output_amount: outcome.outputAmount.toString(),
            recipient,
            tool: outcome.tool,
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
        return reply.code(422).headers(replyHeaders).send({
          error: "slippage_exceeded",
          detail: outcome.detail,
          expected_min: outcome.expectedMin.toString(),
          actual: outcome.actual.toString(),
          bps_tolerance: outcome.bpsTolerance,
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
