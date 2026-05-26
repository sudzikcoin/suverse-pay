import type { HealthStatus } from "@suverse-pay/core-types";
import type { Pool } from "pg";
import type { ProviderRegistry } from "./registry.js";
import type { Logger } from "./types.js";
import { NOOP_LOGGER } from "./types.js";

export const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 30_000;

/**
 * Fast background cron that calls `adapter.healthCheck()` on every
 * registered (enabled) provider and persists the result to
 * `provider_health_checks`. Powers the router's quiet-period fallback
 * (TASK.md §"Routing logic v0.1" step 2) when payment_attempts traffic
 * is too low to make a statistically meaningful call.
 *
 * - Health-check exceptions are caught and recorded as
 *   `status = 'down'` so the failure remains visible to the router.
 * - Disabled providers are skipped — they're already excluded from
 *   routing.
 */
export class HealthCheckCron {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly pool: Pool,
    private readonly intervalMs: number = DEFAULT_HEALTH_CHECK_INTERVAL_MS,
    private readonly logger: Logger = NOOP_LOGGER,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const provider of this.registry.enabled()) {
        let health: HealthStatus;
        try {
          health = await provider.adapter.healthCheck();
        } catch (err) {
          health = {
            status: "down",
            error: err instanceof Error ? err.message : String(err),
            checkedAt: new Date().toISOString(),
          };
          this.logger.warn(`healthCheck threw for ${provider.id}`, {
            error: health.error ?? "",
          });
        }
        await this.record(provider.id, health);
      }
    } finally {
      this.running = false;
    }
  }

  private async record(providerId: string, health: HealthStatus): Promise<void> {
    await this.pool.query(
      `INSERT INTO provider_health_checks (provider_id, status, latency_ms, error, checked_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        providerId,
        health.status,
        health.latencyMs ?? null,
        health.error ?? null,
        new Date(health.checkedAt),
      ],
    );
  }
}
