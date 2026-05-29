import { createWebhookQueue, type WebhookQueue } from "@suverse-pay/webhooks";

/**
 * Lazy singleton BullMQ Queue for the dashboard's manual-retry
 * endpoint. The Queue is a producer-only — the actual workers run
 * inside apps/api and consume the same queue. This file is the only
 * module in the dashboard that imports bullmq.
 *
 * Why a singleton: each new Queue opens a Redis connection. Without
 * a singleton, every POST to the retry endpoint would leak a
 * connection (or pay the ~10ms open/close cost).
 */
let cached: WebhookQueue | null = null;

export function getWebhookQueue(): WebhookQueue {
  if (cached !== null) return cached;
  const url = process.env.REDIS_URL;
  if (url === undefined || url.length === 0) {
    throw new Error(
      "REDIS_URL env var is required for webhook retry endpoints",
    );
  }
  const parsed = new URL(url);
  cached = createWebhookQueue({
    host: parsed.hostname,
    port: parsed.port.length > 0 ? Number(parsed.port) : 6379,
  });
  return cached;
}
