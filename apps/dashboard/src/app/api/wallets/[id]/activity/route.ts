import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdminEmail } from "@/lib/admin";
import { tryGetWalletById } from "@/lib/suverse-wallets";
import { loadWalletActivity } from "@/lib/wallets-activity";

const MAX_DAYS = 90;
const MAX_LIMIT = 200;

/**
 * GET /api/wallets/[id]/activity?days=7&limit=50
 *
 * Unified inbound/outbound/swap/refund event stream for one wallet,
 * sorted newest first. Admin-only. 15-second cache — short enough
 * to feel live during operator triage, long enough to dampen burst
 * loads when several tabs are open.
 */
export async function GET(
  req: Request,
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
  if (!tryGetWalletById(id)) {
    return NextResponse.json({ error: "unknown_wallet_id" }, { status: 404 });
  }
  const url = new URL(req.url);
  const days = clamp(parseInt(url.searchParams.get("days") ?? "7", 10), 1, MAX_DAYS, 7);
  const limit = clamp(
    parseInt(url.searchParams.get("limit") ?? "50", 10),
    1,
    MAX_LIMIT,
    50,
  );
  const events = await loadWalletActivity(id, days, limit);
  return NextResponse.json(
    { walletId: id, days, limit, events },
    { headers: { "cache-control": "private, max-age=15" } },
  );
}

function clamp(n: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < lo) return fallback;
  return Math.min(n, hi);
}
