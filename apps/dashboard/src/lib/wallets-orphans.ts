/**
 * Orphan-token detection for swap wallets.
 *
 * Premise: a healthy swap wallet only ever holds two things between
 * swaps — USDC (working capital + accrued fees) and a little native
 * gas. Any non-zero balance of an OUTPUT token (WETH, AERO, ...)
 * sitting in the wallet after the swap that produced it is by
 * definition a stranded delivery: the executor forwarded to the
 * buyer in the happy path. When the post-balance read raced
 * (mainnet.base.org load-balancer), the executor recorded
 * failed_slippage and never forwarded — the WETH is the deposit.
 *
 * Algorithm per swap wallet:
 *   1. Walk the balance snapshot's `extras[]` — every entry is an
 *      output_token the wallet has ever touched (the API already
 *      seeds extras from swap_transactions).
 *   2. Skip zero balances.
 *   3. For each non-zero token, find the most recent swap_transactions
 *      row for (network, output_token).
 *      - Status = quoted / executing → the swap is in flight; the
 *        balance is expected to be there for ~seconds. NOT orphan.
 *      - Otherwise (completed / failed / failed_slippage / expired) →
 *        ORPHAN. completed shouldn't keep stock either: the executor
 *        transfers everything before flipping the row.
 *
 * Returns the per-wallet item list plus a count; USD valuation of
 * the stranded amount is left for a price-oracle follow-up — the
 * frontend's red badge only needs `count > 0` to fire.
 */

import { dbQuery } from "./db";
import { SUVERSE_WALLETS, type SuverseWallet } from "./suverse-wallets";
import type { TokenBalance, WalletBalanceSnapshot } from "./wallets-onchain";

export interface OrphanItem {
  walletId: string;
  /** Address / mint of the stranded token. */
  tokenIdentifier: string;
  /** Display symbol — currently a truncated mint per the API extras. */
  symbol: string;
  amountAtomic: string;
  /** quote_id of the most recent matching swap row, for the reconcile script. */
  suspectQuoteId: string | null;
  /** Status of that suspect row — explains *why* this is flagged. */
  suspectStatus: string | null;
}

export interface OrphanReport {
  items: OrphanItem[];
  countRows: number;
  /**
   * USD valuation deferred to a price-oracle follow-up. Kept on
   * the response shape so wiring stays stable.
   */
  totalUsdcAtomic: string;
}

const IN_FLIGHT_STATUSES = new Set(["quoted", "executing"]);

export async function detectOrphans(
  snapshots: ReadonlyArray<WalletBalanceSnapshot>,
): Promise<OrphanReport> {
  const items: OrphanItem[] = [];
  for (const snap of snapshots) {
    const wallet = SUVERSE_WALLETS.find((w) => w.id === snap.walletId);
    if (!wallet || wallet.kind !== "swap") continue;
    const network = networkOfSwapWallet(wallet);
    if (!network) continue;
    for (const extra of snap.extras) {
      if (!isNonZero(extra)) continue;
      const suspect = await loadMostRecentSwap(network, extra.tokenIdentifier);
      if (suspect && IN_FLIGHT_STATUSES.has(suspect.status)) {
        continue; // legit in-flight balance
      }
      items.push({
        walletId: wallet.id,
        tokenIdentifier: extra.tokenIdentifier ?? "",
        symbol: extra.symbol,
        amountAtomic: extra.amountAtomic,
        suspectQuoteId: suspect?.quote_id ?? null,
        suspectStatus: suspect?.status ?? null,
      });
    }
  }
  return {
    items,
    countRows: items.length,
    totalUsdcAtomic: "0",
  };
}

function isNonZero(t: TokenBalance): boolean {
  return /^\d+$/.test(t.amountAtomic) && BigInt(t.amountAtomic) > 0n;
}

function networkOfSwapWallet(w: SuverseWallet): string | null {
  if (w.id === "base-swap") return "eip155:8453";
  if (w.id === "solana-swap") return "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  return null;
}

async function loadMostRecentSwap(
  network: string,
  outputToken: string | undefined,
): Promise<{ quote_id: string; status: string } | null> {
  if (!outputToken) return null;
  const rows = await dbQuery<{ quote_id: string; status: string }>(
    `SELECT quote_id, status FROM swap_transactions
      WHERE network = $1 AND output_token = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [network, outputToken],
  );
  return rows[0] ?? null;
}
