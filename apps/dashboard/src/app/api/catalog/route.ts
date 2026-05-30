import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  CreateListingSchema,
  insertListing,
  listApprovedListings,
  userOwnsResourceKey,
} from "@/lib/catalog-store";
import {
  applyFilter,
  paginate,
  sortForFeed,
  truncateDescription,
  type CatalogFilter,
} from "@/lib/catalog-search";
import { decideAuthenticatedTier } from "@/lib/catalog-moderation";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * GET /api/catalog
 *
 * Public, no auth. Query params: q, network, region, category,
 * verified, limit, cursor. Returns approved listings with the
 * description truncated to 200 chars for the list view. The
 * `nextCursor` is a simple integer offset (catalog is small enough
 * for v1; pagination semantics are stable so we can swap to keyset
 * later without breaking clients).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT),
  );
  const cursorRaw = url.searchParams.get("cursor");
  const cursor = cursorRaw !== null && /^\d+$/.test(cursorRaw)
    ? Number(cursorRaw)
    : null;

  const filter: CatalogFilter = {};
  const q = url.searchParams.get("q");
  if (q !== null && q.length > 0) filter.q = q;
  const network = url.searchParams.get("network");
  if (network !== null && network.length > 0) filter.network = network;
  const region = url.searchParams.get("region");
  if (region !== null && region.length > 0) filter.region = region;
  const category = url.searchParams.get("category");
  if (category !== null && category.length > 0) filter.category = category;
  const verifiedRaw = url.searchParams.get("verified");
  if (verifiedRaw === "true") filter.verified = true;
  else if (verifiedRaw === "false") filter.verified = false;

  const all = await listApprovedListings();
  const filtered = all.filter((l) => applyFilter(l, filter)).sort(sortForFeed);
  const { page, nextCursor } = paginate(filtered, limit, cursor);

  return NextResponse.json({
    listings: page.map((l) => ({
      ...l,
      description: truncateDescription(l.description),
    })),
    total: filtered.length,
    nextCursor,
  });
}

/**
 * POST /api/catalog
 *
 * Authenticated submission. Auto-verified iff `linkResourceKey` is
 * present AND the caller owns it. Otherwise creates a pending
 * external listing.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = CreateListingSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }

  let userOwnsKey = false;
  if (parsed.data.linkResourceKey !== undefined) {
    userOwnsKey = await userOwnsResourceKey({
      userId: session.user.id,
      resourceKeyId: parsed.data.linkResourceKey,
    });
  }
  const decision = decideAuthenticatedTier({
    hasResourceKeyLink: parsed.data.linkResourceKey !== undefined,
    userOwnsKey,
  });

  // Strip linkResourceKey from the payload if the user doesn't own
  // it — the user supplied something they shouldn't have, but the
  // listing itself is still legitimate; just route it through
  // moderation as if no link was attempted.
  const sanitised: z.infer<typeof CreateListingSchema> = decision.isVerified
    ? parsed.data
    : { ...parsed.data, linkResourceKey: undefined };

  const created = await insertListing({
    input: sanitised,
    submittedByUserId: session.user.id,
    submittedEmail: null,
    submissionIp: extractIp(request),
    isVerified: decision.isVerified,
    status: decision.status,
  });
  return NextResponse.json({ listing: created }, { status: 201 });
}

/**
 * Best-effort IP extraction for the submission audit trail. nginx
 * (the production proxy) sets `x-forwarded-for`; in dev the request
 * is direct and headers are empty. We don't trust the header for
 * security decisions — it's only used as an opaque key for the
 * 3-per-day anonymous rate limit.
 */
function extractIp(request: Request): string | null {
  const xff = request.headers.get("x-forwarded-for");
  if (xff !== null && xff.length > 0) {
    const first = xff.split(",")[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  return request.headers.get("x-real-ip") ?? null;
}
