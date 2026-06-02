/**
 * Price formatting helpers for the public catalog and the seller
 * dashboard. Catalog listings carry two prices:
 *
 *   * `price_atomic_min` — the actual amount a buyer pays per call
 *   * `price_atomic_max` — a technical gas-guard / anti-fraud ceiling
 *     that the resource server enforces; NOT a "premium tier".
 *
 * We only render the minimum, because exposing the ceiling to humans
 * and AI agents browsing the Bazaar made every listing read as
 * "$0.001 – $50 per call" which (a) is wrong about the actual price
 * the buyer pays and (b) anchors agents to the wrong number when
 * deciding whether to call the endpoint.
 *
 * The max stays in the DB and the backend — only the UI representation
 * collapses to min-only.
 */

/**
 * Render an atomic USDC amount (6-decimal fixed) as a human dollar
 * string. Sub-dollar amounts keep full precision after the decimal
 * (trailing zeros trimmed); whole-dollar or larger amounts cap to
 * two decimals.
 */
export function formatAtomicUsd(atomic: string): string {
  try {
    const v = BigInt(atomic);
    const dollars = v / 1_000_000n;
    const cents = v % 1_000_000n;
    if (dollars > 0n) {
      const trimmed = cents.toString().padStart(6, "0").slice(0, 2);
      return `$${dollars}.${trimmed}`;
    }
    return `$0.${cents.toString().padStart(6, "0").replace(/0+$/, "") || "0"}`;
  } catch {
    return "$?";
  }
}

/**
 * Public-facing price string for a catalog listing. Always renders
 * the min price only:
 *
 *   single-tier (min === max): "$0.01"
 *   range       (min  <  max): "$0.001" — the max is the gas-guard
 *                              ceiling and not a real upper price.
 *
 * Callers append the price unit ("per call") around this themselves
 * so the formatting helper stays unit-agnostic.
 */
export function formatListingPrice(
  priceAtomicMin: string,
  // Accepted but intentionally unused — keeps the signature ready
  // for a future "show range when tiers are real" change without a
  // call-site refactor.
  _priceAtomicMax?: string | null,
): string {
  return formatAtomicUsd(priceAtomicMin);
}
