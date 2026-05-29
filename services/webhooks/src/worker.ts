import {
  type ConnectionOptions,
  type Job,
  UnrecoverableError,
  Worker,
  type WorkerOptions,
} from "bullmq";
import type { Pool } from "pg";
import {
  getDeliveryById,
  recordDeliveryFailure,
  recordDeliverySuccess,
} from "./deliveries-store.js";
import { getEndpointById, touchEndpointLastUsed } from "./endpoints-store.js";
import {
  QUEUE_NAME,
  RETRY_DELAYS_MS,
  type WebhookJob,
  nextRetryDelayMs,
} from "./queue.js";
import {
  EVENT_ID_HEADER,
  EVENT_TYPE_HEADER,
  SIGNATURE_HEADER,
  signWebhook,
} from "./signer.js";

export interface CreateWorkerOptions {
  pool: Pool;
  connection: ConnectionOptions;
  /** HTTP request timeout per delivery attempt. Default 10s. */
  requestTimeoutMs?: number;
  /** Override the fetch implementation for tests. */
  fetchImpl?: typeof fetch;
  /** Optional structured logger (pino-shaped). */
  log?: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
    error: (obj: object, msg: string) => void;
  };
}

/**
 * Spawn the BullMQ Worker that delivers queued webhook jobs.
 *
 * Outcome handling:
 *   - 2xx response       → recordDeliverySuccess + return (job done)
 *   - 4xx (except 408/429) → throw UnrecoverableError (BullMQ marks
 *                            job failed permanently, no retry)
 *   - 5xx, 408, 429, network error, timeout → throw plain Error
 *                            (BullMQ schedules next attempt via
 *                            custom backoff `nextRetryDelayMs`)
 *
 * On a non-terminal failure with no remaining attempts (attemptsMade
 * hits MAX_ATTEMPTS), BullMQ still throws — we mark `status='dead'`
 * on the row inside recordDeliveryFailure (`isTerminal: true`).
 */
export function createWebhookWorker(
  opts: CreateWorkerOptions,
): Worker<WebhookJob> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
  const log = opts.log;

  const workerOptions: WorkerOptions = {
    connection: opts.connection,
    // Single custom strategy — BullMQ v5 takes one function on
    // settings.backoffStrategy and looks it up when the job
    // configures `backoff: { type: "custom" }`.
    settings: {
      backoffStrategy: (attemptsMade: number) => {
        return nextRetryDelayMs(attemptsMade) ?? 0;
      },
    },
  };

  const worker = new Worker<WebhookJob>(
    QUEUE_NAME,
    async (job: Job<WebhookJob>) => {
      const deliveryId = job.data.deliveryId;
      const delivery = await getDeliveryById(opts.pool, deliveryId);
      if (delivery === null) {
        // Row was deleted (endpoint cascade) — job is meaningless.
        log?.warn(
          { deliveryId },
          "webhook delivery row missing — skipping",
        );
        return;
      }
      if (delivery.status === "success" || delivery.status === "dead") {
        // Manual retry path may re-enqueue an already-final row; bail.
        return;
      }
      const endpoint = await getEndpointById({
        client: opts.pool,
        id: delivery.endpointId,
      });
      if (endpoint === null || !endpoint.isActive) {
        await recordDeliveryFailure({
          client: opts.pool,
          id: deliveryId,
          responseCode: null,
          errorTag: "endpoint_inactive",
          isTerminal: true,
        });
        return;
      }

      const body = JSON.stringify(delivery.payload);
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = signWebhook({
        secret: endpoint.secret,
        body,
        timestamp,
      });

      const isFinalAttempt =
        job.attemptsMade + 1 >= (job.opts.attempts ?? RETRY_DELAYS_MS.length + 1);

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        let response: Response;
        try {
          response = await fetchImpl(endpoint.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": "suverse-pay/1.0 (+https://suverse-pay.suverse.io)",
              [SIGNATURE_HEADER]: signature,
              [EVENT_ID_HEADER]: delivery.eventId,
              [EVENT_TYPE_HEADER]: delivery.eventType,
            },
            body,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (response.status >= 200 && response.status < 300) {
          await recordDeliverySuccess({
            client: opts.pool,
            id: deliveryId,
            responseCode: response.status,
          });
          await touchEndpointLastUsed(opts.pool, endpoint.id);
          log?.info(
            {
              deliveryId,
              endpointId: endpoint.id,
              status: response.status,
            },
            "webhook delivered",
          );
          return;
        }

        // 408 / 429 / 5xx are RETRYABLE; everything else 4xx is terminal.
        const retryable =
          response.status === 408 ||
          response.status === 429 ||
          (response.status >= 500 && response.status < 600);
        const tag =
          response.status === 408
            ? "timeout_response"
            : response.status === 429
            ? "rate_limited"
            : response.status >= 500
            ? "5xx"
            : "4xx_no_retry";

        await recordDeliveryFailure({
          client: opts.pool,
          id: deliveryId,
          responseCode: response.status,
          errorTag: tag,
          isTerminal: !retryable || isFinalAttempt,
          nextAttemptAt:
            retryable && !isFinalAttempt
              ? new Date(
                  Date.now() +
                    (nextRetryDelayMs(job.attemptsMade + 1) ?? 0),
                )
              : undefined,
        });

        if (!retryable) {
          throw new UnrecoverableError(`HTTP ${response.status}`);
        }
        throw new Error(`HTTP ${response.status}`);
      } catch (err) {
        if (err instanceof UnrecoverableError) throw err; // already classified
        const isAbort =
          (err as { name?: string } | null)?.name === "AbortError";
        const isNetwork =
          !isAbort && err instanceof TypeError; // fetch network errors
        const tag = isAbort ? "timeout" : isNetwork ? "network_error" : "unknown_error";
        await recordDeliveryFailure({
          client: opts.pool,
          id: deliveryId,
          responseCode: null,
          errorTag: tag,
          isTerminal: isFinalAttempt,
          nextAttemptAt: isFinalAttempt
            ? undefined
            : new Date(
                Date.now() +
                  (nextRetryDelayMs(job.attemptsMade + 1) ?? 0),
              ),
        });
        throw err instanceof Error ? err : new Error(tag);
      }
    },
    workerOptions,
  );

  return worker;
}
