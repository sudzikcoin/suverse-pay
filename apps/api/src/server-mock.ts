/**
 * Smoke-test entrypoint. Boots the real Fastify app + real
 * Postgres / Redis, but swaps the cosmos-pay + Coinbase CDP HTTP
 * adapters for in-memory fakes that return deterministic responses
 * without touching any external network.
 *
 * Intentionally a separate entrypoint from `index.ts` so the
 * production codepath has zero conditional "test mode" branches.
 * Run via `pnpm dev:mock` (in this package) or the smoke scripts in
 * `scripts/smoke/mocked/`.
 *
 * Env knobs:
 *   API_PORT                    listen port (default 3333 to keep
 *                               clear of the prod-default 3000 and
 *                               the host's LaunchLoop on 3001)
 *   ADMIN_API_KEY               REQUIRED — same value bootstrap put
 *                               in `api_keys.key_hash`
 *   DATABASE_URL                REQUIRED
 *   REDIS_URL                   REQUIRED
 *   SMOKE_COSMOS_PAY_FAIL_MODE  optional ErrorCode (e.g.
 *                               "provider_internal_error"). When set,
 *                               the mock cosmos-pay returns
 *                               settled=false with this errorCode on
 *                               every /settle, so the smoke runner
 *                               can exercise fallback / failure paths.
 *   SMOKE_COSMOS_PAY_LATENCY_MS optional — adds a sleep before
 *                               returning, default 0.
 *   SMOKE_CDP_LATENCY_MS        same for the CDP mock, default 0.
 */
import type {
  Caip2,
  DiscoveredCapability,
  ErrorCode,
  HealthStatus,
  ProviderAdapter,
  QuoteRequest,
  QuoteResponse,
  SettleOptions,
  SettleRequest,
  SettleResponse,
  StatusResponse,
  SupportQuery,
  SupportResult,
  VerifyRequest,
  VerifyResponse,
} from "@suverse-pay/core-types";
import {
  PaymentLedger,
  ProviderRegistry,
  type ProviderHealthSummary,
} from "@suverse-pay/orchestrator";
import { Redis } from "ioredis";
import { Pool } from "pg";
import pino from "pino";
import { loadConfig } from "./config.js";
import type { MetricsSummary, ServerContext } from "./context.js";
import { buildServer } from "./server.js";

interface MockOptions {
  id: string;
  displayName: string;
  capabilities: ReadonlyArray<{ network: Caip2; asset: string; scheme: string }>;
  estimatedFeeUsd: string;
  estimatedLatencyMs: number;
  latencyMs: number;
  failMode?: ErrorCode;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * In-memory ProviderAdapter — never opens a socket. Capabilities are
 * a fixed list; settle returns a deterministic fake tx hash unless
 * `failMode` is set, in which case it returns the matching ErrorCode.
 */
function makeMockAdapter(opts: MockOptions): ProviderAdapter {
  return {
    id: opts.id,
    displayName: opts.displayName,
    async supports(req: SupportQuery): Promise<SupportResult> {
      const matched = opts.capabilities.some(
        (c) =>
          c.network === req.network &&
          c.asset === req.asset &&
          c.scheme === req.scheme,
      );
      return matched ? { supported: true } : { supported: false };
    },
    async quote(req: QuoteRequest): Promise<QuoteResponse> {
      return {
        providerId: opts.id,
        network: req.network,
        asset: req.asset,
        amount: req.amount,
        estimatedFeeUsd: opts.estimatedFeeUsd,
        estimatedLatencyMs: opts.estimatedLatencyMs,
        scheme: req.scheme,
        source: "synthetic",
      };
    },
    async verify(_req: VerifyRequest): Promise<VerifyResponse> {
      if (opts.latencyMs > 0) await sleep(opts.latencyMs);
      return {
        valid: true,
        providerId: opts.id,
        verifiedAt: new Date().toISOString(),
        payer: opts.id === "cosmos-pay" ? "noble1mockpayer" : "0xMockPayer",
      };
    },
    async settle(
      req: SettleRequest,
      _settleOpts?: SettleOptions,
    ): Promise<SettleResponse> {
      if (opts.latencyMs > 0) await sleep(opts.latencyMs);
      if (opts.failMode !== undefined) {
        return {
          settled: false,
          providerId: opts.id,
          network: req.paymentRequirements.network,
          asset: req.paymentRequirements.asset,
          amount: req.paymentRequirements.maxAmountRequired,
          errorCode: opts.failMode,
          errorMessage: `mock ${opts.id} failing in fail-mode for smoke fallback test`,
        };
      }
      return {
        settled: true,
        providerId: opts.id,
        network: req.paymentRequirements.network,
        asset: req.paymentRequirements.asset,
        amount: req.paymentRequirements.maxAmountRequired,
        payer: opts.id === "cosmos-pay" ? "noble1mockpayer" : "0xMockPayer",
        txHash: `MOCK_TX_${opts.id.toUpperCase()}_${Date.now()}`,
        settledAt: new Date().toISOString(),
      };
    },
    async getStatus(id: string): Promise<StatusResponse> {
      return {
        providerId: opts.id,
        providerPaymentId: id,
        status: "settled",
      };
    },
    async healthCheck(): Promise<HealthStatus> {
      return { status: "healthy", checkedAt: new Date().toISOString() };
    },
    async discoverCapabilities(): Promise<DiscoveredCapability[]> {
      return opts.capabilities.map((c) => ({
        network: c.network,
        asset: c.asset,
        scheme: c.scheme,
      }));
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig({
    ...process.env,
    API_PORT: process.env.API_PORT ?? "3333",
  });
  const logger = pino({
    level: config.logLevel,
    transport:
      config.nodeEnv === "development"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
  });

  const pool = new Pool({ connectionString: config.databaseUrl });
  const redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
  });

  const registry = new ProviderRegistry(pool, {
    info: (m, c) => logger.info(c ?? {}, m),
    warn: (m, c) => logger.warn(c ?? {}, m),
    error: (m, c) => logger.error(c ?? {}, m),
  });
  const ledger = new PaymentLedger(pool, redis);

  const cosmosLatency = Number(process.env.SMOKE_COSMOS_PAY_LATENCY_MS ?? "0");
  const cdpLatency = Number(process.env.SMOKE_CDP_LATENCY_MS ?? "0");
  const cosmosFail = process.env.SMOKE_COSMOS_PAY_FAIL_MODE as
    | ErrorCode
    | undefined;

  const cosmosCaps: MockOptions["capabilities"] = [
    {
      network: "cosmos:noble-1",
      asset: "uusdc",
      scheme: "exact_cosmos_authz",
    },
  ];
  const cdpCaps: MockOptions["capabilities"] = [
    { network: "eip155:8453", asset: "0xUSDC", scheme: "exact" },
    { network: "eip155:137", asset: "0xUSDC", scheme: "exact" },
  ];

  const cosmosMock = makeMockAdapter({
    id: "cosmos-pay",
    displayName: "Mock cosmos-pay (smoke)",
    capabilities: cosmosCaps,
    estimatedFeeUsd: "0.0001",
    estimatedLatencyMs: 400,
    latencyMs: cosmosLatency,
    ...(cosmosFail !== undefined ? { failMode: cosmosFail } : {}),
  });
  const cdpMock = makeMockAdapter({
    id: "coinbase-cdp",
    displayName: "Mock Coinbase CDP (smoke)",
    capabilities: cdpCaps,
    estimatedFeeUsd: "0.001",
    estimatedLatencyMs: 200,
    latencyMs: cdpLatency,
  });

  await registry.register(cosmosMock, {
    config: { baseUrl: "mock://cosmos-pay", estimatedFeeUsd: "0.0001" },
    staticCapabilities: cosmosCaps,
  });
  await registry.register(cdpMock, {
    config: { baseUrl: "mock://coinbase-cdp", estimatedFeeUsd: "0.001" },
    staticCapabilities: cdpCaps,
  });

  const ctx: ServerContext = {
    config,
    registry,
    ledger,
    loadHealthSummaries: (ids) => loadHealthSummariesFromDb(pool, ids),
    loadMetrics: () => loadMetricsFromDb(pool),
  };

  const app = await buildServer({ ctx, redis });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "smoke server shutdown");
    await app.close();
    await pool.end();
    redis.disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: config.apiHost, port: config.apiPort });
  logger.info(
    { host: config.apiHost, port: config.apiPort, failMode: cosmosFail },
    "suverse-pay smoke server listening",
  );
}

async function loadHealthSummariesFromDb(
  pool: Pool,
  providerIds: ReadonlyArray<string>,
): Promise<Map<string, ProviderHealthSummary>> {
  const out = new Map<string, ProviderHealthSummary>();
  for (const id of providerIds) {
    out.set(id, {
      providerId: id,
      recentAttempts: 0,
      recentFailures: 0,
      lastCheck: null,
      successRate7d: 1,
      avgLatencyMs7d: id === "cosmos-pay" ? 400 : 200,
      estimatedFeeUsd: id === "cosmos-pay" ? "0.0001" : "0.001",
    });
  }
  void pool;
  return out;
}

async function loadMetricsFromDb(pool: Pool): Promise<MetricsSummary> {
  const [byStatus, byProvider] = await Promise.all([
    pool.query<{ status: string; n: string }>(
      `SELECT status, COUNT(*)::text AS n FROM payments GROUP BY status`,
    ),
    pool.query<{
      provider_id: string;
      attempts: string;
      successes: string;
      failures: string;
      avg_latency_ms: string | null;
    }>(
      `SELECT provider_id,
              COUNT(*)::text AS attempts,
              SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END)::text AS successes,
              SUM(CASE WHEN outcome <> 'success' AND outcome <> 'pending' THEN 1 ELSE 0 END)::text AS failures,
              AVG(latency_ms)::text AS avg_latency_ms
         FROM payment_attempts
        GROUP BY provider_id`,
    ),
  ]);
  const status: Record<string, number> = {};
  let total = 0;
  for (const row of byStatus.rows) {
    const n = Number(row.n);
    status[row.status] = n;
    total += n;
  }
  const settled = status.settled ?? 0;
  return {
    totals: {
      payments: total,
      settled,
      failed: status.failed ?? 0,
      pending: status.pending ?? 0,
      successRate: total === 0 ? 0 : settled / total,
    },
    providers: byProvider.rows.map((r) => ({
      providerId: r.provider_id,
      attempts: Number(r.attempts),
      successes: Number(r.successes),
      failures: Number(r.failures),
      avgLatencyMs: r.avg_latency_ms !== null ? Number(r.avg_latency_ms) : null,
    })),
    generatedAt: new Date().toISOString(),
  };
}

main().catch((err: unknown) => {
  process.stderr.write(
    `smoke server failed to start: ${
      err instanceof Error ? err.message : String(err)
    }\n`,
  );
  process.exit(1);
});
