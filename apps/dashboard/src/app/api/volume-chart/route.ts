import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  getLinkedResourceKeys,
  loadVolumeChart,
  periodToSince,
  type Period,
} from "@/lib/queries";

const PeriodSchema = z.enum(["24h", "7d", "30d"]).default("24h");

/**
 * GET /api/volume-chart?period=24h|7d|30d
 *
 * Time-bucketed settled volume series for the line chart.
 * 24h → hourly buckets, 7d/30d → daily buckets.
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
  const includeTestnet = url.searchParams.get("testnet") === "1";
  const keys = await getLinkedResourceKeys(session.user.id);
  const points = await loadVolumeChart({
    resourceKeyIds: keys,
    since: periodToSince(period),
    period,
    includeTestnet,
  });
  return NextResponse.json({ period, points });
}
