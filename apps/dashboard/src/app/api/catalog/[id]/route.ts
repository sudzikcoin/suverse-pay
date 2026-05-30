import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  CreateListingSchema,
  getListing,
  incrementViewCount,
  suspendListing,
  updateListing,
} from "@/lib/catalog-store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/catalog/:id
 *
 * Public. Increments view_count opportunistically — we don't
 * de-dupe by IP at this layer (the dashboard issues a cookie that
 * the listing-detail page uses to avoid double-counting on
 * refreshes). The DB UPDATE is fire-and-forget so a slow write
 * doesn't block the read.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const listing = await getListing(id);
  if (listing === null) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // Only expose approved listings publicly. Pending/rejected/
  // suspended rows surface only on /api/catalog/my-submissions
  // (auth-scoped to the submitter).
  if (listing.status !== "approved") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // Fire-and-forget. Catch so a counter blip never 500s the read.
  incrementViewCount(id).catch(() => {
    /* ignore */
  });
  return NextResponse.json({ listing });
}

/**
 * PUT /api/catalog/:id
 *
 * Submitter-only edit. Significant changes (URL, networks,
 * facilitator URL) push the listing back to pending. Cross-tenant
 * guard lives in updateListing (WHERE submitted_by_user_id = $).
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  // Partial: reuse the same schema but make every field optional.
  // Calling .partial() preserves the inner refinements (httpsURL,
  // network array minimums) only on the fields that ARE supplied.
  const parsed = CreateListingSchema.partial().safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }
  const updated = await updateListing({
    id,
    userId: session.user.id,
    patch: parsed.data,
  });
  if (updated === null) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ listing: updated });
}

/**
 * DELETE /api/catalog/:id
 *
 * Soft-delete: sets status='suspended'. The row is preserved so
 * the audit trail (catalog_external_submissions FK with CASCADE)
 * stays intact.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const ok = await suspendListing({
    id,
    userId: session.user.id,
  });
  if (!ok) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
