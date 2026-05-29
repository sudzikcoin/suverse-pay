import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { revokeResourceKey } from "@/lib/queries";

/**
 * DELETE /api/keys/:id
 *
 * Soft-revoke (sets `is_active = false` on the matched
 * resource_api_keys row). Never DELETEs the row — facilitator_payments
 * FKs against it, and CASCADE would drop the audit trail.
 *
 * Cross-tenant guard: the UPDATE joins through
 * dashboard_user_resource_keys, so a request for someone else's key
 * touches zero rows and we return 404 — identical to "not found".
 * Never confirms that a stranger's key exists.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!/^reskey_[0-9a-f]+$/.test(id)) {
    return NextResponse.json({ error: "invalid key id format" }, { status: 400 });
  }
  const revoked = await revokeResourceKey({
    userId: session.user.id,
    resourceKeyId: id,
  });
  if (!revoked) {
    return NextResponse.json(
      { error: "key not found or already revoked" },
      { status: 404 },
    );
  }
  return NextResponse.json({ resourceKeyId: id, revoked: true });
}
