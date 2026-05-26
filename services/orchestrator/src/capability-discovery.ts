import type { Caip2 } from "@suverse-pay/core-types";
import type { Pool } from "pg";
import type { ProviderRegistry } from "./registry.js";
import type { Logger } from "./types.js";
import { NOOP_LOGGER } from "./types.js";

export const DEFAULT_DISCOVERY_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Slow background cron that calls `adapter.discoverCapabilities()` on
 * every registered provider and reconciles the result against the
 * static rows in `provider_capabilities`.
 *
 * - New (provider, network, asset, scheme) tuples → upserted with
 *   `is_discovered = TRUE` and `discovered_at = now()`.
 * - Previously-static rows missing from the latest discovery →
 *   `superseded_at = now()` so they fall out of routing.
 * - Adapters that don't expose `discoverCapabilities` are skipped.
 * - Discovery errors are logged but never thrown — the next cron tick
 *   reprocesses everything from scratch.
 * - A discovery result of zero capabilities is treated as transient
 *   (e.g. the upstream had an error) and does NOT supersede static
 *   rows. Only a non-empty result is considered authoritative.
 */
export class CapabilityDiscoveryCron {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly pool: Pool,
    private readonly intervalMs: number = DEFAULT_DISCOVERY_INTERVAL_MS,
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
    if (this.running) return; // Re-entrancy guard against overlapping ticks.
    this.running = true;
    try {
      for (const provider of this.registry.list()) {
        if (provider.adapter.discoverCapabilities === undefined) continue;
        try {
          const caps = await provider.adapter.discoverCapabilities();
          await this.reconcile(provider.id, caps);
        } catch (err) {
          this.logger.warn(
            `capability discovery failed for ${provider.id}`,
            { error: err instanceof Error ? err.message : String(err) },
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async reconcile(
    providerId: string,
    discovered: ReadonlyArray<{
      network: Caip2;
      asset: string;
      scheme: string;
    }>,
  ): Promise<void> {
    if (discovered.length === 0) {
      this.logger.warn(
        `provider ${providerId} returned empty capability list — treating as transient, NOT superseding any static rows`,
      );
      return;
    }

    const now = new Date();
    for (const cap of discovered) {
      await this.pool.query(
        `INSERT INTO provider_capabilities (
           provider_id, network, asset, scheme, is_static, is_discovered, discovered_at
         ) VALUES ($1, $2, $3, $4, FALSE, TRUE, $5)
         ON CONFLICT (provider_id, network, asset, scheme) DO UPDATE SET
           is_discovered = TRUE,
           discovered_at = $5,
           superseded_at = NULL`,
        [providerId, cap.network, cap.asset, cap.scheme, now],
      );
    }

    // Find static rows missing from the latest discovery → mark superseded.
    const staticRows = await this.pool.query<{
      network: string;
      asset: string;
      scheme: string;
    }>(
      `SELECT network, asset, scheme FROM provider_capabilities
       WHERE provider_id = $1 AND is_static = TRUE AND superseded_at IS NULL`,
      [providerId],
    );
    const discoveredKeys = new Set(
      discovered.map((c) => `${c.network}|${c.asset}|${c.scheme}`),
    );
    for (const row of staticRows.rows) {
      const key = `${row.network}|${row.asset}|${row.scheme}`;
      if (!discoveredKeys.has(key)) {
        await this.pool.query(
          `UPDATE provider_capabilities SET superseded_at = $5
           WHERE provider_id = $1 AND network = $2 AND asset = $3 AND scheme = $4`,
          [providerId, row.network, row.asset, row.scheme, now],
        );
        this.logger.warn(
          `provider ${providerId} no longer reports static capability (${row.network}, ${row.asset}, ${row.scheme}) — marked superseded`,
        );
      }
    }
  }
}
