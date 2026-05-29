import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  getLinkedResourceKeys,
  loadNetworkBreakdown,
  periodToSince,
  type Period,
} from "@/lib/queries";

const PeriodSchema = z.enum(["24h", "7d", "30d"]).default("24h");

/**
 * GET /api/endpoints?period=24h|7d|30d
 *
 * Renamed in implementation to "network breakdown" because
 * facilitator_payments does not carry an endpoint-path column today
 * (Phase 5 carry-over: extend the wire spec). Per-network grouping
 * is the closest analog the existing schema supports. Same response
 * shape as the original spec — frontend renders this as the
 * "Network breakdown" panel.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const parsed = PeriodSchema.safeParse(url.searchParams.get("period") ?? "24h");
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid period" }, { status: 400 });
  }
  const period: Period = parsed.data;
  const keys = await getLinkedResourceKeys(session.user.id);
  const networks = await loadNetworkBreakdown({
    resourceKeyIds: keys,
    since: periodToSince(period),
  });
  return NextResponse.json({ period, networks });
}
