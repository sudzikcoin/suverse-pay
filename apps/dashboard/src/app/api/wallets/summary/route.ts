import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdminEmail } from "@/lib/admin";
import { SUVERSE_WALLETS, chainOf } from "@/lib/suverse-wallets";
import {
  loadFeesByPeriod,
  loadPendingRefunds,
  loadTopActiveWallets,
} from "@/lib/wallets-activity";
import { readWalletBalances, type ExtraTokenSpec } from "@/lib/wallets-onchain";
import { detectOrphans } from "@/lib/wallets-orphans";
import { dbQuery } from "@/lib/db";

/**
 * GET /api/wallets/summary
 *
 * Aggregate snapshot for the top of /dashboard/wallets:
 *   - Total operational capital across all wallets (sum of USDC
 *     atomic across chains — USDC is 6-dec on all 3 so the sum is
 *     directly meaningful).
 *   - Fees earned today / 7d / 30d + the 30-day daily series for
 *     the bar chart.
 *   - Pending refunds USD value.
 *   - Orphan-tokens USD value (placeholder 0 — landed in commit E).
 *   - Top 5 most active wallets in the last 24h.
 *
 * Admin-only. The fan-out across wallets and chains makes this the
 * most expensive route in the dashboard; cache 30 s so a triple-
 * tab refresh doesn't compound.
 */
export async function GET(): Promise<NextResponse> {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isAdminEmail(email)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Fan out: balances for every wallet (sum the USDC leg + orphan
  // detection for swap wallets), plus the DB aggregates in
  // parallel.
  const [snapshots, fees, refunds, top] = await Promise.all([
    Promise.all(
      SUVERSE_WALLETS.map(async (w) => {
        const extras = w.kind === "swap" ? await swapWalletExtras(w.id) : [];
        return readWalletBalances(w, extras);
      }),
    ),
    loadFeesByPeriod(),
    loadPendingRefunds(),
    loadTopActiveWallets(),
  ]);
  const orphans = await detectOrphans(snapshots);

  let totalUsdcAtomic = 0n;
  const perChain: Record<"base" | "solana" | "cosmos", bigint> = {
    base: 0n,
    solana: 0n,
    cosmos: 0n,
  };
  for (let i = 0; i < SUVERSE_WALLETS.length; i++) {
    const w = SUVERSE_WALLETS[i]!;
    const s = snapshots[i]!;
    if (/^\d+$/.test(s.usdc.amountAtomic)) {
      const v = BigInt(s.usdc.amountAtomic);
      totalUsdcAtomic += v;
      perChain[chainOf(w)] += v;
    }
  }

  return NextResponse.json(
    {
      // Sum of USDC across every SuVerse wallet. UI divides by 1e6.
      operationalCapital: {
        totalUsdcAtomic: totalUsdcAtomic.toString(),
        perChain: {
          base: perChain.base.toString(),
          solana: perChain.solana.toString(),
          cosmos: perChain.cosmos.toString(),
        },
      },
      fees,
      pendingRefunds: {
        countRows: refunds.countRows,
        totalUsdcAtomic: refunds.totalAtomic,
      },
      orphanTokens: {
        countRows: orphans.countRows,
        totalUsdcAtomic: orphans.totalUsdcAtomic,
        items: orphans.items,
      },
      topActiveWallets24h: top,
    },
    { headers: { "cache-control": "private, max-age=30" } },
  );
}

/**
 * Load the swap_transactions output_token set for the given swap
 * wallet, identical to the per-wallet balances route. Pulled into
 * a helper so the orphan check reads the SAME extras the per-card
 * snapshot uses; otherwise the summary's count and the cards could
 * disagree.
 */
async function swapWalletExtras(walletId: string): Promise<ExtraTokenSpec[]> {
  const network = walletId === "base-swap"
    ? "eip155:8453"
    : walletId === "solana-swap"
      ? "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
      : null;
  if (!network) return [];
  const rows = await dbQuery<{ output_token: string }>(
    `SELECT DISTINCT output_token FROM swap_transactions
     WHERE network = $1 AND output_token IS NOT NULL
     ORDER BY output_token
     LIMIT 25`,
    [network],
  );
  const isEvm = network === "eip155:8453";
  return rows.map((r) => ({
    symbol: r.output_token.slice(0, 10) + "…",
    decimals: isEvm ? 18 : 6,
    tokenIdentifier: r.output_token,
  }));
}
