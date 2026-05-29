/**
 * Periodic Postgres → prom-client Gauge refresher. Phase 4 Block 1
 * Sub-task 4.
 *
 * One SQL roll-up per metric per tick. The queries are cheap (all
 * touch indexed columns) but the cron is conservative — `intervalMs`
 * defaults to 15s, matching the Prometheus scrape interval so the
 * dashboard always sees data no older than a tick. Operators can raise
 * the interval (env var `METRICS_REFRESH_INTERVAL_MS`) on a busy
 * deploy.
 *
 * `start()` returns a stopper; `index.ts` keeps the handle for graceful
 * shutdown.
 */
import type { Pool } from "pg";
import {
  adapterHealth,
  facilitatorFailoverEventsTotal,
  facilitatorSettleTotal,
  facilitatorVerifyTotal,
  metricsRefresherLastRunSeconds,
  paymentAmountCount,
  paymentAmountSum,
} from "./metrics.js";

export interface MetricsRefresherOptions {
  pool: Pool;
  intervalMs?: number;
  logger?: {
    info: (msg: string, ctx?: Record<string, unknown>) => void;
    warn: (msg: string, ctx?: Record<string, unknown>) => void;
    error: (msg: string, ctx?: Record<string, unknown>) => void;
  };
}

const DEFAULT_INTERVAL_MS = 15_000;

export class MetricsRefresher {
  private timer: NodeJS.Timeout | undefined;
  private readonly pool: Pool;
  private readonly intervalMs: number;
  private readonly logger: MetricsRefresherOptions["logger"];

  constructor(opts: MetricsRefresherOptions) {
    this.pool = opts.pool;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.logger = opts.logger;
  }

  /**
   * Starts the periodic refresher. Returns an async stopper. Runs an
   * initial refresh immediately so the dashboard isn't empty on the
   * first scrape after boot.
   */
  start(): () => Promise<void> {
    // Fire-and-forget the initial run; failures are logged inside
    // refresh().
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.intervalMs);
    // `unref` so the timer doesn't keep the process alive during tests.
    this.timer.unref?.();
    return async () => {
      if (this.timer !== undefined) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }

  async refresh(): Promise<void> {
    try {
      await Promise.all([
        this.refreshSettleTotals(),
        this.refreshVerifyTotals(),
        this.refreshFailoverEvents(),
        this.refreshAdapterHealth(),
        this.refreshPaymentAmounts(),
      ]);
      metricsRefresherLastRunSeconds.set(Math.floor(Date.now() / 1000));
    } catch (err) {
      this.logger?.warn("metrics-refresher tick failed", {
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
  }

  private async refreshSettleTotals(): Promise<void> {
    // Reset BEFORE the SQL — a label combination that disappears from
    // the result set (e.g. an adapter is decommissioned) should not
    // leave stale gauge values lying around.
    facilitatorSettleTotal.reset();
    const result = await this.pool.query<{
      adapter: string | null;
      network: string;
      status: string;
      count: string;
    }>(`
      SELECT
        COALESCE(adapter_used, 'unknown') AS adapter,
        network,
        status,
        COUNT(*)::text AS count
      FROM facilitator_payments
      GROUP BY adapter, network, status
    `);
    for (const row of result.rows) {
      facilitatorSettleTotal
        .labels({
          adapter: row.adapter ?? "unknown",
          network: row.network,
          status: row.status,
        })
        .set(Number(row.count));
    }
  }

  private async refreshVerifyTotals(): Promise<void> {
    facilitatorVerifyTotal.reset();
    // payment_attempts is the per-attempt audit log of v0.1 settle
    // flow. Verifies aren't separately logged today, but attempts
    // capture the verify+settle round trip — close enough for the
    // dashboard until Phase 5's facilitator-verify ledger lands.
    const result = await this.pool.query<{
      adapter: string;
      network: string;
      status: string;
      count: string;
    }>(`
      SELECT
        pa.provider_id    AS adapter,
        p.network         AS network,
        pa.outcome        AS status,
        COUNT(*)::text    AS count
      FROM payment_attempts pa
      JOIN payments p ON p.id = pa.payment_id
      GROUP BY pa.provider_id, p.network, pa.outcome
    `);
    for (const row of result.rows) {
      facilitatorVerifyTotal
        .labels({
          adapter: row.adapter,
          network: row.network,
          status: row.status,
        })
        .set(Number(row.count));
    }
  }

  private async refreshFailoverEvents(): Promise<void> {
    facilitatorFailoverEventsTotal.reset();
    const result = await this.pool.query<{
      from_adapter: string;
      to_adapter: string;
      network: string;
      count: string;
    }>(`
      SELECT
        e.primary_adapter AS from_adapter,
        e.backup_adapter  AS to_adapter,
        fp.network        AS network,
        COUNT(*)::text    AS count
      FROM facilitator_failover_events e
      JOIN facilitator_payments fp ON fp.id = e.payment_id
      GROUP BY e.primary_adapter, e.backup_adapter, fp.network
    `);
    for (const row of result.rows) {
      facilitatorFailoverEventsTotal
        .labels({
          from_adapter: row.from_adapter,
          to_adapter: row.to_adapter,
          network: row.network,
        })
        .set(Number(row.count));
    }
  }

  private async refreshAdapterHealth(): Promise<void> {
    adapterHealth.reset();
    // Most recent health-check row per provider — DISTINCT ON
    // ordered by checked_at desc. Postgres-specific but the project
    // already requires Postgres.
    const result = await this.pool.query<{
      provider_id: string;
      status: string;
    }>(`
      SELECT DISTINCT ON (provider_id)
        provider_id,
        status
      FROM provider_health_checks
      ORDER BY provider_id, checked_at DESC
    `);
    for (const row of result.rows) {
      const healthy = row.status === "healthy" ? 1 : 0;
      adapterHealth.labels({ adapter: row.provider_id }).set(healthy);
    }
  }

  private async refreshPaymentAmounts(): Promise<void> {
    paymentAmountSum.reset();
    paymentAmountCount.reset();
    const result = await this.pool.query<{
      network: string;
      asset: string;
      sum: string;
      count: string;
    }>(`
      SELECT
        network,
        asset,
        COALESCE(SUM(amount::numeric), 0)::text AS sum,
        COUNT(*)::text                          AS count
      FROM facilitator_payments
      WHERE status = 'settled'
      GROUP BY network, asset
    `);
    for (const row of result.rows) {
      paymentAmountSum
        .labels({ network: row.network, asset: row.asset })
        .set(Number(row.sum));
      paymentAmountCount
        .labels({ network: row.network, asset: row.asset })
        .set(Number(row.count));
    }
  }
}
