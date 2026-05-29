import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getPool } from "@/lib/db";
import {
  getEndpointById,
  listDeliveriesForEndpoint,
} from "@suverse-pay/webhooks";

interface PublicDelivery {
  id: string;
  eventId: string;
  eventType: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: string | null;
  lastResponseCode: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
}

/**
 * GET /api/webhooks/:id/deliveries?limit=50
 *
 * Recent delivery attempts for the endpoint. Payload + headers
 * are not included by default to keep the response small — a
 * future debug-view endpoint can return the full envelope if
 * needed. Scoped by dashboard_user_id to prevent cross-tenant
 * peeking at another customer's webhook log.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  const pool = getPool();
  const endpoint = await getEndpointById({
    client: pool,
    id,
    dashboardUserId: session.user.id,
  });
  if (endpoint === null) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(request.url);
  const limitRaw = url.searchParams.get("limit");
  const limit = Math.min(
    200,
    Math.max(1, limitRaw === null ? 50 : Number(limitRaw) || 50),
  );
  const rows = await listDeliveriesForEndpoint({
    client: pool,
    endpointId: id,
    limit,
  });
  const deliveries: PublicDelivery[] = rows.map((r) => ({
    id: r.id,
    eventId: r.eventId,
    eventType: r.eventType,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    lastAttemptAt: r.lastAttemptAt?.toISOString() ?? null,
    lastResponseCode: r.lastResponseCode,
    lastError: r.lastError,
    nextAttemptAt: r.nextAttemptAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
  return NextResponse.json({ deliveries });
}
