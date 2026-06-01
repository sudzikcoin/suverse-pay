import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { loadRecentPayments } from "@/lib/dashboard-aggregates";
import { getLinkedResourceKeys } from "@/lib/queries";

/**
 * GET /api/dashboard/recent-payments?limit=10&external_only=true
 *
 * Latest settled payments. External-only by default so the
 * dashboard surfaces real-buyer activity instead of smoke tests.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? "10");
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(100, Math.floor(rawLimit)))
    : 10;
  const externalOnly = url.searchParams.get("external_only") !== "false";
  const includeTestnet = url.searchParams.get("testnet") === "1";
  const keys = await getLinkedResourceKeys(session.user.id);
  const payments = await loadRecentPayments({
    resourceKeyIds: keys,
    limit,
    externalOnly,
    includeTestnet,
  });
  return NextResponse.json({ externalOnly, payments });
}
