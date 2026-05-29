import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";

export const QUEUE_NAME = "suverse-pay-webhooks";

export interface WebhookJob {
  deliveryId: string;
}

/** Public alias so consumers don't need a bullmq dep themselves. */
export type WebhookQueue = Queue<WebhookJob>;

/**
 * BullMQ retry/backoff policy. Six attempts, exponential-ish steps:
 *   0:   immediate (the enqueue itself)
 *   1:   +30s   if step 0 failed
 *   2:   +2m    if step 1 failed
 *   3:   +10m   …
 *   4:   +1h
 *   5:   +6h
 *   6:   +24h  → after this the delivery is marked 'dead'
 *
 * BullMQ's `attempts` includes the FIRST try, so 7 total tries = 6
 * delayed-retry attempts. We match that to our 6-step backoff list.
 */
export const RETRY_DELAYS_MS: ReadonlyArray<number> = [
  30 * 1000,
  2 * 60 * 1000,
  10 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
] as const;

export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1; // 7 = 1 initial + 6 retries

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: MAX_ATTEMPTS,
  // Custom backoff handled in the worker via `nextRetryDelayMs`.
  // BullMQ's built-in `backoff: { type: 'custom' }` requires a
  // registered settings strategy on the WORKER side — we wire that
  // in worker.ts.
  backoff: { type: "custom" },
  // Once the job is done (success or final fail) we don't keep it
  // forever in Redis. webhook_deliveries is the durable record.
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 10_000 },
};

export function createWebhookQueue(connection: ConnectionOptions): Queue<WebhookJob> {
  return new Queue<WebhookJob>(QUEUE_NAME, { connection });
}

export function nextRetryDelayMs(attemptsMade: number): number | null {
  // attemptsMade is 1-indexed when BullMQ asks "what delay before the
  // NEXT attempt?". The first failure means attemptsMade=1; we use
  // RETRY_DELAYS_MS[0] for that.
  const idx = attemptsMade - 1;
  if (idx < 0 || idx >= RETRY_DELAYS_MS.length) return null;
  return RETRY_DELAYS_MS[idx] ?? null;
}
