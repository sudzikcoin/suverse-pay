import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  loadRevenueSummary,
  periodToSince,
  type Period,
} from "@/lib/dashboard-aggregates";
import { getLinkedResourceKeys } from "@/lib/queries";

const PeriodSchema = z.enum(["24h", "7d", "30d", "all"]).default("24h");

/**
 * GET /api/dashboard/summary?period=24h|7d|30d|all&testnet=1
 *
 * Top-of-dashboard revenue snapshot: total / external / self splits
 * plus settle counts and distinct external payers in the window.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const parsed = PeriodSchema.safeParse(url.searchParams.get("period") ?? "24h");
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_period" }, { status: 400 });
  }
  const period: Period = parsed.data;
  const includeTestnet = url.searchParams.get("testnet") === "1";
  const keys = await getLinkedResourceKeys(session.user.id);
  const summary = await loadRevenueSummary({
    resourceKeyIds: keys,
    since: periodToSince(period),
    includeTestnet,
  });
  const { period: _drop, ...rest } = summary;
  void _drop;
  return NextResponse.json({ period, includeTestnet, ...rest });
}
