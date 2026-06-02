import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getSwapStats, listSwapLogs } from "@/lib/proxy-config-store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RangeSchema = z.enum(["24h", "7d", "30d"]).default("24h");
const RANGE_HOURS: Record<z.infer<typeof RangeSchema>, number> = {
  "24h": 24,
  "7d": 7 * 24,
  "30d": 30 * 24,
};

/**
 * GET /api/proxies/[id]/swap-stats?range=24h|7d|30d
 *
 * Returns swap_transactions-derived activity for proxies whose
 * internal_handler is swap_solana_execute or swap_base_execute.
 * Returns 404 for non-swap proxies so the client can branch on the
 * status code without having to know which handler names qualify.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const rangeParsed = RangeSchema.safeParse(
    url.searchParams.get("range") ?? "24h",
  );
  const range = rangeParsed.success ? rangeParsed.data : "24h";
  const stats = await getSwapStats({
    userId: session.user.id,
    proxyId: id,
    sinceHours: RANGE_HOURS[range],
  });
  if (stats === null) {
    return NextResponse.json({ error: "not_a_swap_proxy" }, { status: 404 });
  }
  const recent = await listSwapLogs({
    userId: session.user.id,
    proxyId: id,
    limit: 20,
  });
  return NextResponse.json({ range, stats, recent });
}
