import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getLinkedResourceKeys, loadRecentSettles } from "@/lib/queries";

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  filter: z.enum(["all", "settled", "failed"]).default("all"),
});

/**
 * GET /api/settles?limit=50&filter=all|settled|failed
 *
 * Most recent settles for the user's linked resource keys.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    limit: url.searchParams.get("limit") ?? undefined,
    filter: url.searchParams.get("filter") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid query" }, { status: 400 });
  }
  const keys = await getLinkedResourceKeys(session.user.id);
  const settles = await loadRecentSettles({
    resourceKeyIds: keys,
    limit: parsed.data.limit,
    filter: parsed.data.filter,
  });
  return NextResponse.json({ settles });
}
