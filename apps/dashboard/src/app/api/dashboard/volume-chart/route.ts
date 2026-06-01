import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  loadExternalVolumeChart,
  periodToSince,
} from "@/lib/dashboard-aggregates";
import { getLinkedResourceKeys } from "@/lib/queries";

const PeriodSchema = z.enum(["24h", "7d", "30d"]).default("7d");

/**
 * GET /api/dashboard/volume-chart?period=24h|7d|30d
 *
 * External-only volume series for the redesigned dashboard chart.
 * "All time" intentionally not supported here — the chart is meant
 * to show a trend over a bounded recent window.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const parsed = PeriodSchema.safeParse(url.searchParams.get("period") ?? "7d");
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_period" }, { status: 400 });
  }
  const period = parsed.data;
  const includeTestnet = url.searchParams.get("testnet") === "1";
  const since = periodToSince(period);
  if (!since) {
    return NextResponse.json({ error: "invalid_period" }, { status: 400 });
  }
  const keys = await getLinkedResourceKeys(session.user.id);
  const points = await loadExternalVolumeChart({
    resourceKeyIds: keys,
    since,
    period,
    includeTestnet,
  });
  return NextResponse.json({ period, points });
}
