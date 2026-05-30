import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { isAdminEmail } from "@/lib/admin";
import { moderateListing } from "@/lib/catalog-store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Body = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approved") }),
  z.object({
    decision: z.literal("rejected"),
    reason: z.string().min(3).max(500),
  }),
]);

/**
 * PATCH /api/admin/catalog/[id]
 * Body: { decision: 'approved' } | { decision: 'rejected', reason: string }
 *
 * Admin-only (ADMIN_EMAILS allowlist). Transitions a pending listing
 * to approved or rejected; records reviewer email + timestamp.
 * Stdout-logs a notification stub (mirrors catalog-moderation.ts
 * verification-link pattern); real SMTP is a follow-up.
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isAdminEmail(email)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
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
  const reason = parsed.data.decision === "rejected" ? parsed.data.reason : null;
  const updated = await moderateListing({
    id,
    reviewerEmail: email!,
    decision: parsed.data.decision,
    reason,
  });
  if (updated === null) {
    return NextResponse.json(
      { error: "not_found_or_already_decided" },
      { status: 404 },
    );
  }
  // Notification stub — operator can scrape journalctl. Real SMTP
  // lands when the email service is wired in.
  process.stdout.write(
    `[catalog] '${updated.title}' (${updated.id}) → ${updated.status}` +
      (reason ? ` — reason: ${reason}` : "") +
      ` by ${email}\n`,
  );
  return NextResponse.json({ listing: updated });
}
