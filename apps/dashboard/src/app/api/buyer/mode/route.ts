import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { setUserMode } from "@/lib/buyer";

/**
 * POST /api/buyer/mode { mode: "seller" | "buyer" }
 *
 * Persists the user's mode preference. The DashboardHeader posts
 * here when the toggle is clicked, then refreshes the page so the
 * server component re-evaluates the redirect rule.
 */
const Body = z.object({ mode: z.enum(["seller", "buyer"]) });

export async function POST(req: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  await setUserMode(session.user.id, parsed.data.mode);
  return NextResponse.json({ ok: true });
}
