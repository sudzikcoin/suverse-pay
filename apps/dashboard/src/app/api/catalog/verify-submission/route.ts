import { NextResponse } from "next/server";
import { verifyExternalSubmission } from "@/lib/catalog-store";

/**
 * GET /api/catalog/verify-submission?token=...
 *
 * Anonymous. The verification page links here after the user clicks
 * the link from the email (which, for v1, lands in the journalctl
 * log — see catalog-moderation.logVerificationLink).
 *
 * On success: marks verified_at = NOW(). The listing's status
 * remains 'pending' until admin moderation (deferred sub-task).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (token === null || token.length === 0) {
    return NextResponse.json({ error: "missing token" }, { status: 400 });
  }
  const result = await verifyExternalSubmission(token);
  if (!result.ok) {
    const status = result.reason === "not-found" ? 404 : 410;
    return NextResponse.json(
      { ok: false, reason: result.reason },
      { status },
    );
  }
  return NextResponse.json({
    ok: true,
    listingId: result.listingId,
    alreadyVerified: result.reason === "already-verified",
  });
}
