import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdminEmail } from "@/lib/admin";
import { getUserMode } from "@/lib/buyer";

/**
 * GET /api/user/nav-state
 *
 * Returns the nav-relevant slice of the session for the mobile
 * drawer: `{ isAdmin, mode }`. The drawer fetches this lazily on
 * first open so the rest of the app keeps DashboardHeader as a
 * pure pass-through and stays importable from client components
 * (otherwise the server-only `auth()` + `pg` would get dragged
 * into client bundles via the transitive header import chain).
 *
 * 401 for anonymous callers; the drawer falls back to the public
 * item set in that case.
 */
export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const [mode] = await Promise.all([getUserMode(session.user.id)]);
  return NextResponse.json(
    {
      isAdmin: isAdminEmail(session.user.email),
      mode,
    },
    {
      // Private-cache so a back/forward cache hit stays quick but
      // mode flips after a /api/buyer/mode POST are picked up on
      // the next deliberate fetch.
      headers: { "Cache-Control": "private, max-age=10" },
    },
  );
}
