import { CoinbaseCdpAdapter } from "@suverse-pay/adapter-coinbase-cdp";
import { CosmosPayAdapter } from "@suverse-pay/adapter-cosmos-pay";
import { PayAiAdapter } from "@suverse-pay/adapter-payai";
import { FacilitatorRateLimiter } from "@suverse-pay/facilitator";
import {
  CapabilityDiscoveryCron,
  HealthCheckCron,
  PaymentLedger,
  ProviderRegistry,
  RedisUsageTracker,
  type ProviderHealthSummary,
} from "@suverse-pay/orchestrator";
import { Redis } from "ioredis";
import { Pool } from "pg";
import pino from "pino";
import { loadConfig } from "./config.js";
import type { MetricsSummary, ServerContext } from "./context.js";
import { sha256Hex, ADMIN_API_KEY_ID } from "./plugins/auth.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
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
    enableReadyCheck: true,
    lazyConnect: false,
  });

  await verifyAdminApiKey(pool, config.adminApiKey, logger);

  const registry = new ProviderRegistry(pool, {
    info: (m, c) => logger.info(c, m),
    warn: (m, c) => logger.warn(c, m),
    error: (m, c) => logger.error(c, m),
  });
  const ledger = new PaymentLedger(pool, redis);

  // ---- Provider registration ------------------------------------------
  const cosmosPay = new CosmosPayAdapter({
    baseUrl: config.cosmosPayBaseUrl,
    networkAssets: {
      "cosmos:noble-1": ["uusdc"],
      "cosmos:grand-1": ["uusdc"],
    },
    estimatedFeeUsd: "0.0001",
  });
  await registry.register(cosmosPay, {
    config: { baseUrl: config.cosmosPayBaseUrl, estimatedFeeUsd: "0.0001" },
    staticCapabilities: [
      { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      { network: "cosmos:grand-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
    ],
  });

  // Static capability declarations. `asset` is the on-chain identifier
  // CDP expects to see in `PaymentRequirements.asset`:
  //   - EVM: the ERC-20 contract address (Circle's native USDC deployments).
  //   - Solana: the SPL token mint (Circle's native USDC mint).
  // The Solana network identifier is the canonical CAIP-2 mainnet
  // genesis-hash form per x402 spec — matches what signer-solana
  // produces and what Bazaar advertises. NOT `solana:mainnet`.
  const cdpCaps = [
    // EVM — Circle native USDC contracts
    { network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", scheme: "exact" },
    { network: "eip155:137", asset: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", scheme: "exact" },
    { network: "eip155:42161", asset: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", scheme: "exact" },
    // Base Sepolia — Circle's test USDC. Added in v0.3.1 to satisfy
    // scripts/smoke/real-evm/; CDP's /supported advertises this kind
    // alongside the mainnet EVM entries.
    { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", scheme: "exact" },
    // Solana mainnet — Circle native USDC mint + EURC mint
    { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", scheme: "exact" },
    { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr", scheme: "exact" },
  ] as const;

  if (
    config.coinbaseCdpApiKeyName !== undefined &&
    config.coinbaseCdpApiKeyName.length > 0 &&
    config.coinbaseCdpApiKeySecret !== undefined &&
    config.coinbaseCdpApiKeySecret.length > 0
  ) {
    const cdp = new CoinbaseCdpAdapter({
      apiKeyName: config.coinbaseCdpApiKeyName,
      apiKeySecret: config.coinbaseCdpApiKeySecret,
      capabilities: cdpCaps.map((c) => ({
        network: c.network,
        asset: c.asset,
        scheme: c.scheme,
      })),
      estimatedFeeUsd: "0.001",
      monthlyHardCap: config.coinbaseCdpMonthlyHardCap,
      usageTracker: new RedisUsageTracker(redis, "cdp:usage"),
      ...(config.coinbaseCdpBaseUrl !== undefined &&
      config.coinbaseCdpBaseUrl.length > 0
        ? { baseUrl: config.coinbaseCdpBaseUrl }
        : {}),
    });
    await registry.register(cdp, {
      config: {
        baseUrl:
          config.coinbaseCdpBaseUrl ??
          "https://api.cdp.coinbase.com/platform/v2/x402",
        monthlyHardCap: config.coinbaseCdpMonthlyHardCap,
        estimatedFeeUsd: "0.001",
      },
      staticCapabilities: cdpCaps.map((c) => ({
        network: c.network,
        asset: c.asset,
        scheme: c.scheme,
      })),
    });
  } else {
    logger.warn(
      "COINBASE_CDP_API_KEY_NAME / COINBASE_CDP_API_KEY_SECRET not set — skipping Coinbase CDP registration",
    );
  }

  // ---- PayAI (Solana mainnet via facilitator.payai.network) -----------
  // Free tier needs no credentials; we register the adapter by default
  // and gate registration on `payAiEnabled` so an operator can disable
  // PayAI without touching code.
  if (config.payAiEnabled) {
    // Same Circle native mainnet mints as the CDP Solana entries — the
    // gateway can fail over between CDP and PayAI for any (network,
    // asset, scheme) pair that both list. Drift between the two adapter
    // configurations would break that, so keep them in sync.
    const payAiCaps = [
      {
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        scheme: "exact",
      },
      {
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        asset: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr",
        scheme: "exact",
      },
    ] as const;
    const payAi = new PayAiAdapter({
      capabilities: payAiCaps.map((c) => ({
        network: c.network,
        asset: c.asset,
        scheme: c.scheme,
      })),
      estimatedFeeUsd: "0.001",
      ...(config.payAiBaseUrl !== undefined && config.payAiBaseUrl.length > 0
        ? { baseUrl: config.payAiBaseUrl }
        : {}),
      ...(config.payAiApiKeyId !== undefined &&
      config.payAiApiKeyId.length > 0 &&
      config.payAiApiKeySecret !== undefined &&
      config.payAiApiKeySecret.length > 0
        ? { apiKeyId: config.payAiApiKeyId, apiKeySecret: config.payAiApiKeySecret }
        : {}),
    });
    await registry.register(payAi, {
      config: {
        baseUrl: config.payAiBaseUrl ?? "https://facilitator.payai.network",
        estimatedFeeUsd: "0.001",
      },
      staticCapabilities: payAiCaps.map((c) => ({
        network: c.network,
        asset: c.asset,
        scheme: c.scheme,
      })),
    });
  } else {
    logger.warn("PAYAI_ENABLED=false — skipping PayAI registration");
  }

  // ---- Background crons ------------------------------------------------
  const orchLogger = {
    info: (m: string, c?: Record<string, unknown>) => logger.info(c ?? {}, m),
    warn: (m: string, c?: Record<string, unknown>) => logger.warn(c ?? {}, m),
    error: (m: string, c?: Record<string, unknown>) => logger.error(c ?? {}, m),
  };
  const discoveryCron = new CapabilityDiscoveryCron(
    registry,
    pool,
    config.capabilityDiscoveryIntervalMs,
    orchLogger,
  );
  const healthCron = new HealthCheckCron(
    registry,
    pool,
    config.healthCheckIntervalMs,
    orchLogger,
  );
  discoveryCron.start();
  healthCron.start();

  // ---- ServerContext glue ---------------------------------------------
  const facilitatorRateLimiter = new FacilitatorRateLimiter({ redis });
  const ctx: ServerContext = {
    config,
    registry,
    ledger,
    pool,
    facilitatorRateLimiter,
    loadHealthSummaries: (providerIds) =>
      loadHealthSummariesFromDb(pool, providerIds),
    loadMetrics: () => loadMetricsFromDb(pool),
  };

  const app = await buildServer({ ctx, redis });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutdown initiated");
    discoveryCron.stop();
    healthCron.stop();
    await app.close();
    await pool.end();
    redis.disconnect();
    logger.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: config.apiHost, port: config.apiPort });
  logger.info(
    { host: config.apiHost, port: config.apiPort },
    "suverse-pay API listening",
  );
}

async function verifyAdminApiKey(
  pool: Pool,
  adminApiKey: string,
  logger: { warn: (msg: string) => void; error: (msg: string) => void },
): Promise<void> {
  try {
    const expected = sha256Hex(adminApiKey);
    const result = await pool.query<{ key_hash: string }>(
      `SELECT key_hash FROM api_keys WHERE id = $1 AND revoked_at IS NULL`,
      [ADMIN_API_KEY_ID],
    );
    if (result.rows.length === 0) {
      logger.warn(
        `admin api_key row '${ADMIN_API_KEY_ID}' not present in DB — run pnpm db:bootstrap`,
      );
      return;
    }
    if (result.rows[0]!.key_hash !== expected) {
      logger.error(
        `admin api_key row '${ADMIN_API_KEY_ID}' hash does not match ADMIN_API_KEY env — re-run pnpm db:bootstrap if you rotated the key`,
      );
    }
  } catch (err) {
    logger.warn(
      `could not verify admin api_key (db unreachable?): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function loadHealthSummariesFromDb(
  pool: Pool,
  providerIds: ReadonlyArray<string>,
): Promise<Map<string, ProviderHealthSummary>> {
  const out = new Map<string, ProviderHealthSummary>();
  if (providerIds.length === 0) return out;

  // Recent attempts (last 60s).
  const recent = await pool.query<{
    provider_id: string;
    attempts: string;
    failures: string;
  }>(
    `SELECT provider_id,
            COUNT(*)::text AS attempts,
            SUM(CASE WHEN outcome <> 'success' THEN 1 ELSE 0 END)::text AS failures
       FROM payment_attempts
      WHERE started_at > NOW() - INTERVAL '60 seconds'
        AND provider_id = ANY($1)
      GROUP BY provider_id`,
    [providerIds],
  );

  // 7-day rolling avg latency + success rate.
  const rolling = await pool.query<{
    provider_id: string;
    avg_latency_ms: string | null;
    success_rate: string | null;
  }>(
    `SELECT provider_id,
            AVG(latency_ms)::text AS avg_latency_ms,
            (SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END)::numeric
              / NULLIF(COUNT(*), 0))::text AS success_rate
       FROM payment_attempts
      WHERE started_at > NOW() - INTERVAL '7 days'
        AND provider_id = ANY($1)
      GROUP BY provider_id`,
    [providerIds],
  );

  // Latest provider_health_checks row per provider.
  const lastCheck = await pool.query<{
    provider_id: string;
    status: string;
    checked_at: Date;
  }>(
    `SELECT DISTINCT ON (provider_id) provider_id, status, checked_at
       FROM provider_health_checks
      WHERE provider_id = ANY($1)
      ORDER BY provider_id, checked_at DESC`,
    [providerIds],
  );

  const recentBy = new Map(recent.rows.map((r) => [r.provider_id, r]));
  const rollingBy = new Map(rolling.rows.map((r) => [r.provider_id, r]));
  const checkBy = new Map(lastCheck.rows.map((r) => [r.provider_id, r]));

  for (const id of providerIds) {
    const r = recentBy.get(id);
    const ro = rollingBy.get(id);
    const c = checkBy.get(id);
    out.set(id, {
      providerId: id,
      recentAttempts: r ? Number(r.attempts) : 0,
      recentFailures: r ? Number(r.failures) : 0,
      lastCheck: c
        ? {
            status: c.status as "healthy" | "degraded" | "down",
            checkedAt: c.checked_at,
          }
        : null,
      successRate7d: ro ? Number(ro.success_rate ?? 1) : 1,
      avgLatencyMs7d: ro ? Number(ro.avg_latency_ms ?? 0) : 0,
    });
  }
  return out;
}

async function loadMetricsFromDb(pool: Pool): Promise<MetricsSummary> {
  const [byStatus, byProvider, facByKey, facByNetwork, facByAdapter, failoverCount] =
    await Promise.all([
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
          WHERE started_at > NOW() - INTERVAL '24 hours'
          GROUP BY provider_id`,
      ),
      pool.query<{
        resource_key_id: string;
        label: string;
        settled: string;
        failed: string;
      }>(
        `SELECT fp.resource_key_id,
                rak.label,
                SUM(CASE WHEN fp.status = 'settled' THEN 1 ELSE 0 END)::text AS settled,
                SUM(CASE WHEN fp.status = 'failed'  THEN 1 ELSE 0 END)::text AS failed
           FROM facilitator_payments fp
           JOIN resource_api_keys    rak ON rak.id = fp.resource_key_id
          WHERE fp.created_at > NOW() - INTERVAL '24 hours'
          GROUP BY fp.resource_key_id, rak.label`,
      ),
      pool.query<{ network: string; settled: string; failed: string }>(
        `SELECT network,
                SUM(CASE WHEN status = 'settled' THEN 1 ELSE 0 END)::text AS settled,
                SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END)::text AS failed
           FROM facilitator_payments
          WHERE created_at > NOW() - INTERVAL '24 hours'
          GROUP BY network`,
      ),
      pool.query<{ adapter_used: string; settled: string; failed: string }>(
        `SELECT adapter_used,
                SUM(CASE WHEN status = 'settled' THEN 1 ELSE 0 END)::text AS settled,
                SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END)::text AS failed
           FROM facilitator_payments
          WHERE created_at > NOW() - INTERVAL '24 hours' AND adapter_used IS NOT NULL
          GROUP BY adapter_used`,
      ),
      pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n
           FROM facilitator_failover_events
          WHERE created_at > NOW() - INTERVAL '24 hours'`,
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
  const failed = status.failed ?? 0;
  const pending = status.pending ?? 0;
  return {
    totals: {
      payments: total,
      settled,
      failed,
      pending,
      successRate: total === 0 ? 0 : settled / total,
    },
    providers: byProvider.rows.map((r) => ({
      providerId: r.provider_id,
      attempts: Number(r.attempts),
      successes: Number(r.successes),
      failures: Number(r.failures),
      avgLatencyMs: r.avg_latency_ms !== null ? Number(r.avg_latency_ms) : null,
    })),
    facilitator: {
      paymentsByResourceKey: facByKey.rows.map((r) => ({
        resourceKeyId: r.resource_key_id,
        label: r.label,
        settled: Number(r.settled),
        failed: Number(r.failed),
      })),
      paymentsByNetwork: facByNetwork.rows.map((r) => ({
        network: r.network,
        settled: Number(r.settled),
        failed: Number(r.failed),
      })),
      adapterSelections: facByAdapter.rows.map((r) => ({
        adapter: r.adapter_used,
        settled: Number(r.settled),
        failed: Number(r.failed),
      })),
      failoverEvents: Number(failoverCount.rows[0]?.n ?? "0"),
    },
    generatedAt: new Date().toISOString(),
  };
}

main().catch((err: unknown) => {
  console.error("fatal during bootstrap", err);
  process.exit(1);
});
