import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdminEmail } from "@/lib/admin";
import { SUVERSE_WALLETS } from "@/lib/suverse-wallets";

/**
 * GET /api/wallets/list
 *
 * Admin-only enumeration of every SuVerse-controlled wallet
 * tracked by /dashboard/wallets. Returns the static registry from
 * `suverse-wallets.ts` unchanged — no DB hit. Cache for 5 min so
 * the page-load tax stays small (the registry is code-deployed,
 * not user-mutable, so a stale read can't be wrong).
 */
export async function GET(): Promise<NextResponse> {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isAdminEmail(email)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json(
    { wallets: SUVERSE_WALLETS },
    { headers: { "cache-control": "private, max-age=300" } },
  );
}
