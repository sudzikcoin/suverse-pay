import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  loadTopEndpoints,
  periodToSince,
} from "@/lib/dashboard-aggregates";
import { getLinkedResourceKeys } from "@/lib/queries";

const PeriodSchema = z.enum(["24h", "7d", "30d"]).default("24h");

/**
 * GET /api/dashboard/top-endpoints?period=24h&limit=5
 *
 * Top N proxy endpoints by external revenue in the window.
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
  const since = periodToSince(parsed.data);
  if (!since) {
    return NextResponse.json({ error: "invalid_period" }, { status: 400 });
  }
  const rawLimit = Number(url.searchParams.get("limit") ?? "5");
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(50, Math.floor(rawLimit)))
    : 5;
  const includeTestnet = url.searchParams.get("testnet") === "1";
  const keys = await getLinkedResourceKeys(session.user.id);
  const endpoints = await loadTopEndpoints({
    resourceKeyIds: keys,
    since,
    limit,
    includeTestnet,
  });
  return NextResponse.json({ period: parsed.data, endpoints });
}
