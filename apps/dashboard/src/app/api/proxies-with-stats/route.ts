import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  loadProxyListWithStats,
  periodToSince,
} from "@/lib/dashboard-aggregates";

const PeriodSchema = z.enum(["24h", "7d", "30d"]).default("24h");

/**
 * GET /api/proxies-with-stats?period=24h
 *
 * Single-shot list of every proxy the caller owns, with the
 * per-row stats columns (requests, settled, errors, external vs
 * self revenue, last-settle) the redesigned /dashboard/proxies
 * table needs. Kept distinct from /api/proxies — the original list
 * route is the canonical "raw config" endpoint and unchanged for
 * back-compat with existing screens.
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
  const includeTestnet = url.searchParams.get("testnet") === "1";
  const proxies = await loadProxyListWithStats({
    userId: session.user.id,
    since,
    includeTestnet,
  });
  return NextResponse.json({ period: parsed.data, proxies });
}
