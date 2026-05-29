import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import type { ClientBase, Pool, PoolClient } from "pg";
import { createOrFetchDelivery } from "./deliveries-store.js";
import {
  findMatchingEndpoints,
  type WebhookEventType,
} from "./endpoints-store.js";
import {
  buildSettleEnvelope,
  type SettlePayloadObject,
} from "./event-payload.js";
import { DEFAULT_JOB_OPTIONS, type WebhookJob } from "./queue.js";

export interface EnqueueSettleEventOptions {
  client: ClientBase | PoolClient | Pool;
  queue: Queue<WebhookJob>;
  /** Settle row from facilitator_payments (already finalized). */
  settle: SettlePayloadObject & { resource_key_id: string };
  /** Settle outcome → event type mapping handled by caller. */
  eventType: WebhookEventType;
  /** Overrideable in tests. */
  now?: Date;
}

export interface EnqueueResult {
  /** Number of endpoints that matched and got a delivery row + queued job. */
  fannedOutTo: number;
  /** Delivery ids inserted (matches fannedOutTo unless dedup hit). */
  deliveryIds: string[];
}

/**
 * Fan-out a settle event to every matching webhook endpoint:
 *
 *   1. Resolve endpoints via dashboard_user_resource_keys join.
 *   2. For each endpoint, insert a webhook_deliveries row (idempotent
 *      on (endpoint_id, event_id)).
 *   3. Push a BullMQ job per delivery so the worker picks it up.
 *
 * The eventId is fresh per call — replays of the same settle (e.g.
 * idempotent /facilitator/settle returning a cached row) hit
 * different eventIds and therefore SHOULD NOT re-fanout. Callers
 * pass eventType only when this is a new settle outcome. The
 * settle handler in apps/api only calls this once per finalize.
 */
export async function enqueueSettleEvent(
  opts: EnqueueSettleEventOptions,
): Promise<EnqueueResult> {
  const endpoints = await findMatchingEndpoints({
    client: opts.client,
    resourceKeyId: opts.settle.resource_key_id,
    eventType: opts.eventType,
  });
  if (endpoints.length === 0) {
    return { fannedOutTo: 0, deliveryIds: [] };
  }
  const now = opts.now ?? new Date();
  // One event id PER ENDPOINT — receivers dedupe per their own
  // endpoint; we don't want two endpoints sharing an id because
  // their idempotency keys collide.
  const deliveryIds: string[] = [];
  for (const ep of endpoints) {
    const eventId = `evt_${randomUUID()}`;
    const envelope = buildSettleEnvelope({
      eventId,
      eventType: opts.eventType,
      now,
      object: opts.settle,
    });
    const { row } = await createOrFetchDelivery({
      client: opts.client,
      endpointId: ep.id,
      eventId,
      eventType: opts.eventType,
      payload: envelope as unknown as Record<string, unknown>,
    });
    await opts.queue.add(
      "deliver",
      { deliveryId: row.id },
      DEFAULT_JOB_OPTIONS,
    );
    deliveryIds.push(row.id);
  }
  return { fannedOutTo: endpoints.length, deliveryIds };
}
