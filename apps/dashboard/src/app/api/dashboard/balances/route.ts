import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { loadDashboardBalances } from "@/lib/onchain-balances";

/**
 * GET /api/dashboard/balances
 *
 * On-chain USDC balances for the calling user's distinct payTo
 * addresses (Base / Solana / Cosmos). 30s edge cache by way of
 * Cache-Control on the response — balances move slowly enough that
 * any tighter freshness is wasted RPC budget.
 */
export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const balances = await loadDashboardBalances(session.user.id);
  return NextResponse.json(balances, {
    headers: { "cache-control": "private, max-age=30" },
  });
}
