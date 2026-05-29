/**
 * Platform fee computation.
 *
 * Suverse-pay currently does NOT collect the fee on-chain — the
 * downstream facilitator (CDP / PayAI / Thirdweb / …) settles the
 * full `paymentRequirements.maxAmountRequired` to the merchant's
 * `paymentRequirements.payTo` address, and we have no authority to
 * rewrite either field (the buyer signed over the exact amount + to
 * the exact recipient). This module is the accounting overlay: the
 * settle writer calls `computeFee(gross, bps)` and stores all three
 * of (gross, fee, net) in `facilitator_payments`. The dashboard
 * surfaces the split, and the operator collects the `fee_amount`
 * sum out-of-band (CSV invoice export → manual USDC transfer or
 * Stripe invoice).
 *
 * On-chain withholding is a separate Sub-task (3.5) — would need
 * per-chain splitter contracts or a native facilitator with custody.
 */

/** USDC has 6 decimals everywhere we currently route, so 1 atomic unit = $0.000001. */
export const MIN_FEE_ATOMIC = 1n;

/**
 * Cap at $1 in atomic USDC (6-decimal) = 1_000_000. Protects against
 * runaway charges on a single large settle while we're still tuning
 * the model. The cap is denominated in USDC atomic units; BNB Chain's
 * 18-decimal USDC/USDT routes will require a per-chain cap in a
 * future iteration (Phase 5 follow-on — currently no BNB traffic so
 * this is acceptable).
 */
export const MAX_FEE_USDC_ATOMIC = 1_000_000n;

export interface FeeSplit {
  /** What the buyer paid (= on-chain transfer amount, unchanged). */
  gross: bigint;
  /** Platform fee — sum these across a period to invoice. */
  fee: bigint;
  /** What the merchant net receives (= gross - fee). */
  net: bigint;
}

/**
 * Apply `feeBps` to a gross atomic amount, returning the three-part
 * split. Pure function — safe to call repeatedly.
 *
 * Edge cases:
 *   - feeBps = 0       → fee = 0, net = gross (backwards-compat path)
 *   - computed fee < MIN_FEE_ATOMIC → bumped up to MIN_FEE_ATOMIC,
 *     so micro-settles never round to "free for us"
 *   - computed fee > MAX_FEE_USDC_ATOMIC → capped
 *   - gross <= MIN_FEE_ATOMIC → fee = max(0n, gross - 1n) so the
 *     merchant always nets at least 1 atomic unit (otherwise the
 *     book entry would be a net = 0 settle, which is meaningless)
 *
 * Invariant: `gross === fee + net`. Enforced by Postgres CHECK on
 * `facilitator_payments` too — see migration 004.
 */
export function computeFee(gross: bigint, feeBps: number): FeeSplit {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) {
    throw new RangeError(
      `feeBps must be an integer in [0, 1000]; got ${feeBps}`,
    );
  }
  if (gross < 0n) {
    throw new RangeError(`gross must be non-negative; got ${gross}`);
  }
  if (feeBps === 0 || gross === 0n) {
    return { gross, fee: 0n, net: gross };
  }
  // Special case: gross = 1 atomic unit — there's nothing to split.
  // The merchant keeps the whole atomic; we record fee = 0.
  if (gross <= MIN_FEE_ATOMIC) {
    return { gross, fee: 0n, net: gross };
  }
  let fee = (gross * BigInt(feeBps)) / 10_000n;
  if (fee > MAX_FEE_USDC_ATOMIC) {
    fee = MAX_FEE_USDC_ATOMIC;
  }
  if (fee < MIN_FEE_ATOMIC) {
    fee = MIN_FEE_ATOMIC;
  }
  // Safety net for very small gross where floor would consume the
  // whole amount. Guarantee the merchant net ≥ 1 atomic.
  if (fee >= gross) {
    fee = gross - 1n;
  }
  return { gross, fee, net: gross - fee };
}
