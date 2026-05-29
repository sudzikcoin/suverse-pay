import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { getWebhookQueue } from "@/lib/webhook-queue";
import {
  DEFAULT_JOB_OPTIONS,
  getEndpointById,
  resetDeliveryForManualRetry,
} from "@suverse-pay/webhooks";

/**
 * POST /api/webhooks/:id/deliveries/:deliveryId/retry
 *
 * Manual retry of a failed or dead delivery. Resets the row to
 * 'pending', bumps max_attempts so a dead delivery gets a fresh
 * retry budget, then enqueues a BullMQ job for the worker to
 * pick up.
 *
 * The dashboard speaks to the queue directly (separate Redis
 * connection from apps/api's worker, same queue name + Redis URL)
 * — BullMQ is a distributed queue, multiple producers is the
 * intended pattern.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; deliveryId: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id, deliveryId } = await context.params;
  const pool = getPool();

  // Scope check FIRST: the URL params encode the endpoint; verify
  // the caller owns it before touching the delivery row.
  const endpoint = await getEndpointById({
    client: pool,
    id,
    dashboardUserId: session.user.id,
  });
  if (endpoint === null) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const reset = await resetDeliveryForManualRetry(pool, deliveryId);
  if (reset === null) {
    return NextResponse.json({ error: "delivery not found" }, { status: 404 });
  }
  if (reset.endpointId !== id) {
    // Defensive: deliveryId is unique across endpoints, but the URL
    // could mismatch. Don't leak which endpoint actually owns it.
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const queue = getWebhookQueue();
  await queue.add(
    "deliver",
    { deliveryId: reset.id },
    DEFAULT_JOB_OPTIONS,
  );
  return NextResponse.json({ ok: true, status: reset.status });
}
