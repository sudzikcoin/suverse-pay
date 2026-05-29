import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { deleteEndpoint } from "@suverse-pay/webhooks";

/**
 * DELETE /api/webhooks/:id
 *
 * Hard delete — `webhook_deliveries` cascade. The store scopes the
 * delete by dashboard_user_id so the same id from another tenant
 * returns 404 rather than a permission error (no info leak about
 * which ids exist).
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
  const ok = await deleteEndpoint({
    client: getPool(),
    id,
    dashboardUserId: session.user.id,
  });
  if (!ok) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
