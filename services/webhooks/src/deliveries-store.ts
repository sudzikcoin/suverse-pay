import { randomUUID } from "node:crypto";
import type { ClientBase, Pool, PoolClient } from "pg";
import type { WebhookEventType } from "./endpoints-store.js";

export type DeliveryStatus = "pending" | "success" | "failed" | "dead";

export interface DeliveryRow {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
  status: DeliveryStatus;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: Date | null;
  lastResponseCode: number | null;
  lastError: string | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
}

export interface CreateDeliveryOptions {
  client: ClientBase | PoolClient | Pool;
  endpointId: string;
  eventId: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
  maxAttempts?: number;
}

export interface CreateDeliveryResult {
  isNew: boolean;
  row: DeliveryRow;
}

/**
 * Insert a pending delivery, or return the existing row when this
 * (endpoint, event_id) pair already has one. Allows the enqueue
 * step to be idempotent — re-running fan-out for the same settle
 * won't double-deliver.
 */
export async function createOrFetchDelivery(
  opts: CreateDeliveryOptions,
): Promise<CreateDeliveryResult> {
  const id = randomUUID();
  const maxAttempts = opts.maxAttempts ?? 6;
  const insert = await opts.client.query(
    `INSERT INTO webhook_deliveries
       (id, endpoint_id, event_id, event_type, payload, status,
        attempts, max_attempts, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', 0, $6, NOW())
     ON CONFLICT (endpoint_id, event_id) DO NOTHING
     RETURNING id, endpoint_id, event_id, event_type, payload, status,
               attempts, max_attempts, last_attempt_at,
               last_response_code, last_error, next_attempt_at, created_at`,
    [
      id,
      opts.endpointId,
      opts.eventId,
      opts.eventType,
      JSON.stringify(opts.payload),
      maxAttempts,
    ],
  );
  if (insert.rows.length > 0) {
    return { isNew: true, row: rowToDelivery(insert.rows[0]) };
  }
  const { rows } = await opts.client.query(
    `SELECT id, endpoint_id, event_id, event_type, payload, status,
            attempts, max_attempts, last_attempt_at,
            last_response_code, last_error, next_attempt_at, created_at
       FROM webhook_deliveries
      WHERE endpoint_id = $1 AND event_id = $2
      LIMIT 1`,
    [opts.endpointId, opts.eventId],
  );
  if (rows.length === 0) {
    throw new Error("webhook_deliveries insert hit ON CONFLICT but SELECT returned nothing");
  }
  return { isNew: false, row: rowToDelivery(rows[0]) };
}

export async function getDeliveryById(
  client: ClientBase | PoolClient | Pool,
  id: string,
): Promise<DeliveryRow | null> {
  const { rows } = await client.query(
    `SELECT id, endpoint_id, event_id, event_type, payload, status,
            attempts, max_attempts, last_attempt_at,
            last_response_code, last_error, next_attempt_at, created_at
       FROM webhook_deliveries
      WHERE id = $1
      LIMIT 1`,
    [id],
  );
  if (rows.length === 0) return null;
  return rowToDelivery(rows[0]);
}

export interface ListDeliveriesOptions {
  client: ClientBase | PoolClient | Pool;
  endpointId: string;
  limit?: number;
}

export async function listDeliveriesForEndpoint(
  opts: ListDeliveriesOptions,
): Promise<DeliveryRow[]> {
  const { rows } = await opts.client.query(
    `SELECT id, endpoint_id, event_id, event_type, payload, status,
            attempts, max_attempts, last_attempt_at,
            last_response_code, last_error, next_attempt_at, created_at
       FROM webhook_deliveries
      WHERE endpoint_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [opts.endpointId, opts.limit ?? 50],
  );
  return rows.map(rowToDelivery);
}

export interface RecordSuccessOptions {
  client: ClientBase | PoolClient | Pool;
  id: string;
  responseCode: number;
}

export async function recordDeliverySuccess(
  opts: RecordSuccessOptions,
): Promise<void> {
  await opts.client.query(
    `UPDATE webhook_deliveries
        SET status = 'success',
            attempts = attempts + 1,
            last_attempt_at = NOW(),
            last_response_code = $2,
            last_error = NULL,
            next_attempt_at = NULL
      WHERE id = $1`,
    [opts.id, opts.responseCode],
  );
}

export interface RecordFailureOptions {
  client: ClientBase | PoolClient | Pool;
  id: string;
  responseCode: number | null;
  errorTag: string;
  /**
   * When true, the delivery is terminal — no further retry. Use for
   * 4xx (other than 408/429) AND when attempts >= max_attempts.
   */
  isTerminal: boolean;
  /** When non-terminal, the scheduler stamps the next try time. */
  nextAttemptAt?: Date;
}

export async function recordDeliveryFailure(
  opts: RecordFailureOptions,
): Promise<void> {
  const newStatus: DeliveryStatus = opts.isTerminal ? "dead" : "pending";
  await opts.client.query(
    `UPDATE webhook_deliveries
        SET status = $2,
            attempts = attempts + 1,
            last_attempt_at = NOW(),
            last_response_code = $3,
            last_error = $4,
            next_attempt_at = $5
      WHERE id = $1`,
    [
      opts.id,
      newStatus,
      opts.responseCode,
      opts.errorTag,
      opts.isTerminal ? null : (opts.nextAttemptAt ?? new Date()),
    ],
  );
}

/**
 * Reset a delivery so the worker picks it up again. Used by the
 * dashboard's manual retry button. Caller MUST also re-enqueue the
 * BullMQ job for the worker to actually take it.
 */
export async function resetDeliveryForManualRetry(
  client: ClientBase | PoolClient | Pool,
  id: string,
): Promise<DeliveryRow | null> {
  const { rows } = await client.query(
    `UPDATE webhook_deliveries
        SET status = 'pending',
            next_attempt_at = NOW(),
            -- max_attempts gets bumped so manual-retry-after-dead
            -- gets a fresh budget rather than failing on attempt 1.
            max_attempts = GREATEST(max_attempts, attempts + 3)
      WHERE id = $1
      RETURNING id, endpoint_id, event_id, event_type, payload, status,
                attempts, max_attempts, last_attempt_at,
                last_response_code, last_error, next_attempt_at, created_at`,
    [id],
  );
  if (rows.length === 0) return null;
  return rowToDelivery(rows[0]);
}

function rowToDelivery(r: {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  max_attempts: number;
  last_attempt_at: Date | null;
  last_response_code: number | null;
  last_error: string | null;
  next_attempt_at: Date | null;
  created_at: Date;
}): DeliveryRow {
  return {
    id: r.id,
    endpointId: r.endpoint_id,
    eventId: r.event_id,
    eventType: r.event_type as WebhookEventType,
    payload: r.payload,
    status: r.status as DeliveryStatus,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    lastAttemptAt: r.last_attempt_at,
    lastResponseCode: r.last_response_code,
    lastError: r.last_error,
    nextAttemptAt: r.next_attempt_at,
    createdAt: r.created_at,
  };
}
