/**
 * Prometheus-format metrics for the suverse-pay gateway. Phase 4
 * Block 1 Sub-task 4 — internal Grafana dashboard support.
 *
 * Design choice: rather than instrument every hot path with
 * prom-client `.inc()` calls (which would touch the orchestrator +
 * facilitator router in many places), we drive the dashboard from
 * Postgres aggregates and use prom-client `Gauge.set()` to expose
 * absolute cumulative snapshots. A small refresher cron in
 * `metrics-refresher.ts` runs the SQL on a 15s tick. Trade-offs:
 *
 *   + No hot-path code changes — adapters/routers stay clean.
 *   + Values survive process restarts (sourced from durable storage).
 *   + One SQL roundtrip per tick keeps load tiny on a dev DB.
 *   - Metric type is Gauge, not Counter — Grafana `rate()` won't behave
 *     intuitively. Use `increase()` over the dashboard window instead
 *     (which works fine on monotonic gauges).
 *   - Sub-second precision is wasted; values are eventually consistent
 *     to ~15s. Fine for dashboards, not for SLO alerts (Phase 5).
 *
 * `adapter_health` is the only true gauge (0/1) — updated by the
 * health-check cron (or this refresher reading the latest
 * provider_health_checks row per provider).
 *
 * Process-level node defaults (heap, gc, event-loop lag) come from
 * `prom-client.collectDefaultMetrics` so the dashboard can also show
 * gateway resource usage without writing custom probes.
 */
import { collectDefaultMetrics, Gauge, Registry } from "prom-client";

/** Single shared registry — bound to the /metrics route in routes/metrics-prom.ts. */
export const metricsRegistry = new Registry();

metricsRegistry.setDefaultLabels({ service: "suverse-pay-api" });

// Node process + GC + heap. ~30 default metrics, all prefixed `process_`
// or `nodejs_`. Cheap; Prometheus skips ones it doesn't care about.
collectDefaultMetrics({ register: metricsRegistry });

/**
 * Cumulative settle count, grouped by adapter that finalized the call,
 * network (CAIP-2), and status (`settled` | `failed` | `pending`).
 * Sourced from `facilitator_payments` aggregated by (adapter_used,
 * network, status).
 */
export const facilitatorSettleTotal = new Gauge({
  name: "facilitator_settle_total",
  help: "Total /facilitator/settle calls observed, by adapter + network + status. Sourced from facilitator_payments; absolute cumulative value.",
  labelNames: ["adapter", "network", "status"] as const,
  registers: [metricsRegistry],
});

/**
 * Cumulative verify count, grouped by provider attempting the verify
 * and outcome. Verifies don't have a dedicated table — we read this
 * from `payment_attempts` where the parent `payments` row was the v0.1
 * (MCP / admin-key) flow. Facilitator's verify path is not
 * persisted today (it doesn't write a payment row), so this metric
 * undercounts the facilitator surface. Phase 5 will add a
 * facilitator_verifies table; for now it's "v0.1 attempts seen".
 */
export const facilitatorVerifyTotal = new Gauge({
  name: "facilitator_verify_total",
  help: "Total /verify calls observed, by adapter + network + outcome. Sourced from payment_attempts joined with payments; absolute cumulative.",
  labelNames: ["adapter", "network", "status"] as const,
  registers: [metricsRegistry],
});

/**
 * Cumulative failover events — counts of (primary_adapter,
 * backup_adapter, network) tuples from facilitator_failover_events
 * joined with facilitator_payments. Drives the "failover events
 * timeline" panel — though for the actual timeline panel Grafana hits
 * Postgres directly for finer detail (payment id, timestamp).
 */
export const facilitatorFailoverEventsTotal = new Gauge({
  name: "facilitator_failover_events_total",
  help: "Total failover events observed: (from_adapter, to_adapter, network). Sourced from facilitator_failover_events.",
  labelNames: ["from_adapter", "to_adapter", "network"] as const,
  registers: [metricsRegistry],
});

/**
 * Rate-limit hits (HTTP 429) per resource key label. Tracked
 * in-process by `apps/api/src/plugins/rate-limit.ts` — bumped on each
 * 429 the facilitator surface emits. Resets on restart; that's fine
 * for the dashboard, which uses `increase()` over short windows.
 */
export const facilitatorRateLimitHitsTotal = new Gauge({
  name: "facilitator_rate_limit_hits_total",
  help: "Rate-limit hits (HTTP 429) per resource key label. Reset on restart.",
  labelNames: ["resource_key_label"] as const,
  registers: [metricsRegistry],
});

/**
 * Adapter health gauge: 1 = last health-check returned `healthy`,
 * 0 = anything else (`degraded`, `down`, or no check yet). Read from
 * the most recent provider_health_checks row per provider.
 */
export const adapterHealth = new Gauge({
  name: "adapter_health",
  help: "Health of each registered adapter — 1 healthy, 0 degraded/down/unknown.",
  labelNames: ["adapter"] as const,
  registers: [metricsRegistry],
});

/**
 * Cumulative settled-payment USDC volume per (network, asset). Stored
 * in atomic units in Postgres (NUMERIC(78,0)); prom-client expects
 * Number, so we coerce to `Number(sum)` knowing dev volumes are well
 * below 2^53. Once we approach that ceiling (sum > ~9e15 atomic =
 * $9e9 for 6-decimal USDC, Phase 5+), switch to bigint or pre-scale.
 */
export const paymentAmountSum = new Gauge({
  name: "payment_amount_sum",
  help: "Sum of settled facilitator payment amounts per network + asset (atomic units).",
  labelNames: ["network", "asset"] as const,
  registers: [metricsRegistry],
});

export const paymentAmountCount = new Gauge({
  name: "payment_amount_count",
  help: "Count of settled facilitator payments per network + asset.",
  labelNames: ["network", "asset"] as const,
  registers: [metricsRegistry],
});

/**
 * Liveness gauge updated by the metrics-refresher cron at the end of
 * each tick — operators can alert on `time() - metrics_refresher_last_run_seconds > 60`
 * to catch a stuck refresher. Initialized to 0 at boot; set to the
 * Unix epoch seconds of the last successful refresh on tick.
 */
export const metricsRefresherLastRunSeconds = new Gauge({
  name: "metrics_refresher_last_run_seconds",
  help: "Unix epoch seconds of the last successful metrics-refresher tick.",
  registers: [metricsRegistry],
});
metricsRefresherLastRunSeconds.set(0);

export type MetricsRegistry = typeof metricsRegistry;
