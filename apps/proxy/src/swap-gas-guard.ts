/**
 * Gas-cost guard for the swap quote endpoints.
 *
 * Threat model: an attacker calls /quote with a tiny input_amount but
 * picks an output token novel enough that creating its ATA / approving
 * its router costs more in gas than our 1 % service fee earns. Each
 * such swap drains the swap-liquidity wallet by the gas delta. A
 * scripted run of $0.001 swaps against fresh tokens can burn the
 * wallet in minutes.
 *
 * Defense: before we hand back a /quote response we cost-check the
 * swap against the wallet state. Two probes, one per chain:
 *
 *   Solana — does the swap wallet hold an associated-token-account
 *     for the OUTPUT mint? If not, the upcoming Jupiter swap will pay
 *     ATA rent (~0.00204 SOL ≈ $0.40 at $200 SOL). The check is a
 *     single `getAccountInfo` against the derived ATA.
 *
 *   Base — does the LiFi router already have a USDC allowance large
 *     enough to cover the input? If not, the executor must broadcast
 *     an `approve` tx first (~$0.005 at typical Base gas prices).
 *     The check is a single `allowance(owner, spender)` read.
 *
 * From the probe result we derive a minimum input that keeps the
 * service fee ≥ gas (break-even or better). The route handler returns
 * `quote_too_small` (HTTP 400) when the buyer's input is below it,
 * surfacing the bumped minimum so the buyer can retry.
 *
 * Numbers (USD, USDC = 6 decimals):
 *
 *   Solana / new token (swap wallet has no ATA for output):
 *     gas = $0.40,   min = max($0.10, $0.40 / 0.01) = $40
 *   Solana / common token (swap wallet already holds the ATA):
 *     gas = $0.002,  min = max($0.10, $0.002 / 0.01) = $0.20
 *   Base / approval needed (router allowance < input):
 *     gas = $0.005 approve + $0.005 swap + $0.001 transfer = $0.011
 *     min = max($1, $0.011 / 0.01) = $1.10
 *   Base / approval already in place:
 *     gas = $0.005 swap + $0.001 transfer = $0.006
 *     min = max($1, $0.006 / 0.01) = $1
 *
 * Why "break-even" rather than "break-even × safety multiplier": at the
 * absolute floor of $0.10 / $1 the per-swap profit floor is already a
 * multiple of the gas estimate, and the dominant residual risk
 * (fresh buyer ATA on Solana, gas-spike on Base) is bounded — neither
 * scales with attacker volume. If those become the dominant loss vector
 * we'll lift the floor here rather than reshape the formula.
 *
 * Module shape: pure functions + dependency-injected probes so vitest
 * can drive them without touching mainnet. The Fastify quote handlers
 * call `evaluateSolanaSwapGas` / `evaluateBaseSwapGas` and treat
 * `ok === false` as a 400. Probe failures fall closed (treat as
 * "needs new ATA / new approval") so an RPC blip can't open the
 * cheap-swap window.
 */

/** SPL associated-token-account rent on Solana mainnet, in USD.
 *  ~0.00203928 SOL @ a conservative SOL price of $200. */
export const SOL_ATA_RENT_USD = 0.4;

/** Typical signature + compute-unit fee for a Solana tx, in USD. */
export const SOL_TX_FEE_USD = 0.002;

/** Approximate gas to call `approve(spender, amount)` on Base USDC, USD. */
export const BASE_APPROVE_USD = 0.005;

/** Approximate gas for one LiFi swap tx on Base, USD. */
export const BASE_SWAP_USD = 0.005;

/** Approximate gas for one ERC20.transfer on Base, USD. */
export const BASE_TRANSFER_USD = 0.001;

/** Absolute minimum input for Solana quotes, USD (USDC). */
export const SOL_ABS_MIN_USD = 0.1;

/** Absolute minimum input for Base quotes, USD (USDC). */
export const BASE_ABS_MIN_USD = 1.0;

/** USDC has 6 atomic decimals on both Solana mainnet and Base mainnet. */
const USDC_DECIMALS = 6;
const USDC_ATOMIC_PER_USD = 10 ** USDC_DECIMALS;

/**
 * Probe seam for Solana. Returns true iff the swap wallet already has
 * an associated-token-account for `outputMint`.
 */
export interface SolanaGasProbe {
  swapWalletHasOutputAta(outputMint: string): Promise<boolean>;
}

/**
 * Probe seam for Base. Returns the current ERC20 allowance the swap
 * wallet has granted `spender` over `inputToken`.
 */
export interface BaseGasProbe {
  allowance(inputToken: string, spender: string): Promise<bigint>;
}

export interface GasGuardOk {
  ok: true;
  /** USDC atomic floor that this token+wallet pair must clear. */
  minimumInputAtomic: bigint;
  /** Worst-case gas estimate that drove the floor, in USD. */
  estimatedGasCostUsd: number;
  /**
   * Human warning to forward to the caller when the floor was raised
   * above the chain default — lets the buyer learn why a token is
   * "expensive to start swapping". Absent when the floor is the
   * absolute default.
   */
  warning?: string;
}

export interface GasGuardRejected {
  ok: false;
  /** Same fields as GasGuardOk so the 400 response can include them. */
  minimumInputAtomic: bigint;
  estimatedGasCostUsd: number;
  /** Machine-readable rejection reason. */
  reason: "quote_too_small";
  /** Human message safe to surface to the API caller. */
  message: string;
}

export type GasGuardResult = GasGuardOk | GasGuardRejected;

/**
 * Service fee ratio shared by both chains. Kept as a plain number
 * because the floor is a USD comparison; the chain-level USDC
 * arithmetic stays in bigint.
 */
function feePct(feeBps: bigint): number {
  return Number(feeBps) / 10_000;
}

function usdToUsdcAtomic(usd: number): bigint {
  if (!Number.isFinite(usd) || usd <= 0) return 0n;
  return BigInt(Math.ceil(usd * USDC_ATOMIC_PER_USD));
}

function maxBigint(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * Decide whether `inputAtomic` (USDC, 6 decimals) is large enough to
 * cover the gas the executor will pay for a Solana → SPL swap of
 * `outputMint` performed by `swapWalletAddress`.
 *
 * Probe failure is treated as "ATA missing" so an RPC hiccup cannot
 * open the cheap-swap window. The probe is a single `getAccountInfo`
 * — cheap enough to call on every quote.
 */
export async function evaluateSolanaSwapGas(args: {
  inputAtomic: bigint;
  outputMint: string;
  feeBps: bigint;
  probe: SolanaGasProbe;
}): Promise<GasGuardResult> {
  let ataExists: boolean;
  try {
    ataExists = await args.probe.swapWalletHasOutputAta(args.outputMint);
  } catch {
    ataExists = false;
  }

  const gasUsd = ataExists
    ? SOL_TX_FEE_USD
    : SOL_ATA_RENT_USD + SOL_TX_FEE_USD;
  return finalizeGasGuard({
    inputAtomic: args.inputAtomic,
    gasUsd,
    feeBps: args.feeBps,
    absMinUsd: SOL_ABS_MIN_USD,
    bumpReason: ataExists
      ? undefined
      : "Output token has no liquidity wallet ATA yet; minimum input " +
        "is raised to cover one-time SPL account rent.",
  });
}

/**
 * Decide whether `inputAtomic` (USDC, 6 decimals) is large enough to
 * cover the gas the executor will pay for a Base USDC → ERC20 swap
 * routed through `lifiSpender` on behalf of `swapWalletAddress`.
 *
 * Probe failure is treated as "approval needed" so an RPC hiccup
 * cannot open the cheap-swap window. The probe is a single ERC20
 * `allowance(owner, spender)` call.
 */
export async function evaluateBaseSwapGas(args: {
  inputAtomic: bigint;
  inputToken: string;
  lifiSpender: string;
  feeBps: bigint;
  probe: BaseGasProbe;
}): Promise<GasGuardResult> {
  let approvalNeeded: boolean;
  try {
    const allowance = await args.probe.allowance(
      args.inputToken,
      args.lifiSpender,
    );
    approvalNeeded = allowance < args.inputAtomic;
  } catch {
    approvalNeeded = true;
  }

  const gasUsd =
    BASE_SWAP_USD +
    BASE_TRANSFER_USD +
    (approvalNeeded ? BASE_APPROVE_USD : 0);
  return finalizeGasGuard({
    inputAtomic: args.inputAtomic,
    gasUsd,
    feeBps: args.feeBps,
    absMinUsd: BASE_ABS_MIN_USD,
    bumpReason: approvalNeeded
      ? "LiFi router has no USDC allowance from the liquidity wallet " +
        "yet; minimum input is raised to cover the one-time approve."
      : undefined,
  });
}

function finalizeGasGuard(args: {
  inputAtomic: bigint;
  gasUsd: number;
  feeBps: bigint;
  absMinUsd: number;
  bumpReason: string | undefined;
}): GasGuardResult {
  const pct = feePct(args.feeBps);
  // pct > 0 always in this codebase (FEE_BPS = 100). Guard anyway so a
  // bad config doesn't divide by zero and silently drop the floor.
  const breakEvenUsd = pct > 0 ? args.gasUsd / pct : Number.POSITIVE_INFINITY;
  const minimumUsd = Math.max(args.absMinUsd, breakEvenUsd);
  const minimumAtomic = maxBigint(
    usdToUsdcAtomic(args.absMinUsd),
    usdToUsdcAtomic(breakEvenUsd),
  );

  if (args.inputAtomic < minimumAtomic) {
    return {
      ok: false,
      minimumInputAtomic: minimumAtomic,
      estimatedGasCostUsd: round4(args.gasUsd),
      reason: "quote_too_small",
      message:
        `Minimum input for this token is ${formatUsd(minimumUsd)} USDC ` +
        `(estimated gas cost ${formatUsd(args.gasUsd)} USDC at our 1% fee). ` +
        `Provided input was ${formatUsdcAtomic(args.inputAtomic)} USDC.`,
    };
  }

  const result: GasGuardOk = {
    ok: true,
    minimumInputAtomic: minimumAtomic,
    estimatedGasCostUsd: round4(args.gasUsd),
  };
  // Surface the bump reason only when the gas-driven floor is above
  // the absolute default — otherwise the warning is noise.
  if (args.bumpReason !== undefined && breakEvenUsd > args.absMinUsd) {
    result.warning = args.bumpReason;
  }
  return result;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function formatUsd(n: number): string {
  // Always show 2 dp; gas / fee math doesn't need more.
  return n.toFixed(2);
}

function formatUsdcAtomic(atomic: bigint): string {
  const whole = atomic / 1_000_000n;
  const frac = atomic % 1_000_000n;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

/**
 * Shape grafted into the `/quote` response when the guard passes.
 * Lets the buyer see what gas the executor expects to pay and the
 * net token amount that should land after gas.
 */
export interface GasGuardQuoteFields {
  /** USD estimate for the executor's combined gas cost. */
  estimated_gas_cost_usd: number;
  /** Floor this token+wallet pair must clear, USDC atomic (6 dp). */
  minimum_input_atomic: string;
  /** Present only when the floor was bumped above the absolute default. */
  warning?: string;
}

export function buildGasGuardQuoteFields(
  guard: GasGuardOk,
): GasGuardQuoteFields {
  const out: GasGuardQuoteFields = {
    estimated_gas_cost_usd: guard.estimatedGasCostUsd,
    minimum_input_atomic: guard.minimumInputAtomic.toString(),
  };
  if (guard.warning !== undefined) out.warning = guard.warning;
  return out;
}
