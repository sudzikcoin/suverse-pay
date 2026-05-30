import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listUserListings } from "@/lib/catalog-store";

/**
 * GET /api/catalog/my-submissions
 *
 * Auth-scoped: returns every listing the caller submitted,
 * regardless of status (pending / approved / rejected / suspended).
 * Powers the /dashboard/catalog table.
 */
export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const listings = await listUserListings(session.user.id);
  return NextResponse.json({ listings });
}
