import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { dbQuery } from "@/lib/db";

/**
 * GET  /api/onboarding  — { dismissedAt: string | null }
 * POST /api/onboarding  — dismisses the in-app welcome tour
 *
 * Persists the welcome-tour dismissal on dashboard_users so a user
 * doesn't see it again across browsers / devices. Idempotent.
 */
export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rows = await dbQuery<{ onboarding_dismissed_at: string | null }>(
    `SELECT onboarding_dismissed_at FROM dashboard_users WHERE id = $1`,
    [session.user.id],
  );
  const dismissedAt = rows[0]?.onboarding_dismissed_at ?? null;
  return NextResponse.json({ dismissedAt });
}

export async function POST(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // COALESCE preserves the original dismissal timestamp on a second
  // POST — useful if we later want "tour dismissed N days ago".
  await dbQuery(
    `UPDATE dashboard_users
       SET onboarding_dismissed_at = COALESCE(onboarding_dismissed_at, NOW())
     WHERE id = $1`,
    [session.user.id],
  );
  return NextResponse.json({ ok: true });
}
