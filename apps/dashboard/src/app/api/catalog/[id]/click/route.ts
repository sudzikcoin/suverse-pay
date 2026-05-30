import { NextResponse } from "next/server";
import { getListing, incrementClickCount } from "@/lib/catalog-store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/catalog/:id/click
 *
 * Public. Fired by the "Use this endpoint" CTA on the detail
 * page. Increments click_count; the dashboard surfaces this as a
 * pseudo-conversion metric for listing owners later (Phase 6).
 *
 * Like the view counter, this is best-effort: a failed write must
 * never block the user's outbound navigation.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const listing = await getListing(id);
  if (listing === null || listing.status !== "approved") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  await incrementClickCount(id);
  return NextResponse.json({ ok: true });
}
