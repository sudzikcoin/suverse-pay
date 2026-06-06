import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { listProxyLogs, type ProxyLogFilter } from "@/lib/proxy-config-store";
import { loadSelfWallets } from "@/lib/dashboard-aggregates";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LimitSchema = z.coerce.number().int().min(1).max(200).default(50);
const FilterSchema = z.enum(["all", "external", "self", "errors"]).default("all");

/** GET /api/proxies/[id]/logs?limit=50&filter=all|external|self|errors */
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
  const limitParsed = LimitSchema.safeParse(
    url.searchParams.get("limit") ?? "50",
  );
  const limit = limitParsed.success ? limitParsed.data : 50;
  const filterParsed = FilterSchema.safeParse(
    url.searchParams.get("filter") ?? "all",
  );
  const filter: ProxyLogFilter = filterParsed.success ? filterParsed.data : "all";
  const logs = await listProxyLogs({
    userId: session.user.id,
    proxyId: id,
    limit,
    filter,
    selfWallets: await loadSelfWallets(),
  });
  return NextResponse.json({ logs });
}
