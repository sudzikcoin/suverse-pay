import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdminEmail } from "@/lib/admin";
import { tryGetWalletById } from "@/lib/suverse-wallets";
import {
  readWalletBalances,
  type ExtraTokenSpec,
} from "@/lib/wallets-onchain";
import { dbQuery } from "@/lib/db";

/**
 * GET /api/wallets/[id]/balances
 *
 * On-chain native + USDC for the wallet, plus any extra tokens
 * derived from `swap_transactions.output_token` rows that touched
 * this wallet (for swap-kind wallets). Surfacing those extras
 * powers the orphan-token check on /dashboard/wallets.
 *
 * 30-second cache: balances move on each settle, but a half-minute
 * stale read is fine for visibility — orphan accounting itself runs
 * against the same RPCs so it picks up the truth even when this
 * cache returns slightly behind.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isAdminEmail(email)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const wallet = tryGetWalletById(id);
  if (!wallet) {
    return NextResponse.json({ error: "unknown_wallet_id" }, { status: 404 });
  }

  const extras: ExtraTokenSpec[] = wallet.kind === "swap"
    ? await loadSwapExtras(wallet.id)
    : [];

  const snapshot = await readWalletBalances(wallet, extras);
  return NextResponse.json(snapshot, {
    headers: { "cache-control": "private, max-age=30" },
  });
}

/**
 * Pull distinct output_token rows the swap wallet has ever touched
 * (regardless of status) so the balance snapshot shows orphans
 * AND the operator can see "we settled this token before, the
 * balance should be 0 now". Caps at 25 to bound the on-chain
 * round-trip count.
 */
async function loadSwapExtras(walletId: string): Promise<ExtraTokenSpec[]> {
  // Both Solana and Base swap rows store the output mint / contract
  // in `output_token`. swap_transactions doesn't carry a wallet id,
  // so we filter by network — the swap registry has exactly one
  // swap wallet per chain in v1.
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
  // Token metadata (symbol / decimals) isn't in swap_transactions —
  // we surface the raw mint and let the UI resolve a friendly label
  // from the token-metadata cache later. 18 decimals is the safe EVM
  // default and 6 the safe SPL default; mismatches read as "0.xxxxx"
  // which is fine for "is there a stray balance" visibility.
  const isEvm = network === "eip155:8453";
  return rows.map((r) => ({
    symbol: r.output_token.slice(0, 10) + "…", // truncated address as label
    decimals: isEvm ? 18 : 6,
    tokenIdentifier: r.output_token,
  }));
}
