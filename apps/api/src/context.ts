import type {
  PaymentLedger,
  ProviderHealthSummary,
  ProviderRegistry,
} from "@suverse-pay/orchestrator";
import type { Config } from "./config.js";

/**
 * Everything the route handlers need from the orchestrator + infra
 * layer, gathered in one object so tests can supply in-memory fakes
 * for every dependency without instantiating a real Postgres pool or
 * Redis client.
 *
 * `buildServer()` (server.ts) takes this; `index.ts` is the only
 * place that actually constructs a Pool / Redis / cron.
 */
export interface ServerContext {
  config: Config;
  registry: ProviderRegistry;
  ledger: PaymentLedger;
  /**
   * Loads ProviderHealthSummary rows for the given provider ids.
   * The orchestrator's router consumes these to decide which
   * providers are healthy enough to route to. Implementation in
   * `index.ts` reads `payment_attempts` (last 60s) and
   * `provider_health_checks` (most recent). Tests supply a fake map.
   */
  loadHealthSummaries: (
    providerIds: ReadonlyArray<string>,
  ) => Promise<Map<string, ProviderHealthSummary>>;
  /**
   * Returns aggregate stats for /metrics/summary. Implementation in
   * `index.ts` is a small SQL roll-up; tests supply a stub object.
   */
  loadMetrics: () => Promise<MetricsSummary>;
  /** Override for deterministic tests. */
  now?: () => Date;
}

export interface MetricsSummary {
  totals: {
    payments: number;
    settled: number;
    failed: number;
    pending: number;
    successRate: number;
  };
  providers: ReadonlyArray<{
    providerId: string;
    attempts: number;
    successes: number;
    failures: number;
    avgLatencyMs: number | null;
  }>;
  generatedAt: string;
}
