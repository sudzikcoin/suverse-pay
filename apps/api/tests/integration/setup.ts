import { CoinbaseCdpAdapter } from "@suverse-pay/adapter-coinbase-cdp";
import { CosmosPayAdapter } from "@suverse-pay/adapter-cosmos-pay";
import {
  ADMIN_API_KEY_ID,
  bootstrapAdminApiKey,
  sha256ApiKeyHash,
} from "@suverse-pay/db";
import {
  PaymentLedger,
  ProviderRegistry,
  type ProviderHealthSummary,
} from "@suverse-pay/orchestrator";
import { generateKeyPairSync } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import nock from "nock";
import { Pool } from "pg";
import { loadConfig } from "../../src/config.js";
import type { MetricsSummary, ServerContext } from "../../src/context.js";
import { buildServer } from "../../src/server.js";

/**
 * Test fixture: an in-process Fastify app wired to the live Docker
 * Postgres + Redis on host ports 5433 / 6380. Outbound HTTP to the
 * two facilitator providers is intercepted by `nock` — adapter code
 * still runs in full (JWT signing, error mapping, retries), but no
 * external network is touched.
 */
export const TEST_ADMIN_API_KEY = "integration-test-admin-key";
export const TEST_ADMIN_BEARER = `Bearer ${TEST_ADMIN_API_KEY}`;

export const COSMOS_PAY_MOCK_HOST = "http://cosmos-pay.mock.test";
export const COINBASE_CDP_MOCK_HOST = "https://cdp.mock.test";
export const COINBASE_CDP_MOCK_PATH = "/platform/v2/x402";
export const COINBASE_CDP_MOCK_BASE = `${COINBASE_CDP_MOCK_HOST}${COINBASE_CDP_MOCK_PATH}`;

/**
 * Returns a fresh Ed25519 PKCS8 PEM each call. Used to satisfy
 * `CoinbaseCdpAdapter`'s `apiKeySecret` constructor parameter — the
 * adapter's signer is overridden to a stub immediately below, so this
 * key never actually signs anything; it only needs to parse. Generating
 * dynamically (instead of pinning a static value) keeps the repo free
 * of anything that looks like a real private key, even one that's only
 * a constructor crutch.
 */
function freshTestEd25519PrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
}

export interface IntegrationStack {
  app: FastifyInstance;
  pool: Pool;
  redis: Redis;
  ledger: PaymentLedger;
  registry: ProviderRegistry;
  ctx: ServerContext;
  metricsRef: { value: MetricsSummary };
}

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://suverse:suverse@localhost:5433/suverse_pay";
const redisUrl =
  process.env.TEST_REDIS_URL ?? "redis://localhost:6380";

/**
 * One-time stack init per file. Idempotently registers cosmos-pay
 * and a CDP adapter pointed at nock-able mock hosts. Adapters use
 * the real cosmos-pay HTTP client + real CDP JWT signing + real
 * undici fetch — only the destination is a `nock` interceptor.
 */
export async function setupStack(): Promise<IntegrationStack> {
  nock.disableNetConnect();
  nock.enableNetConnect((host) => /^(127\.0\.0\.1|::1|localhost)/.test(host));

  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

  // Ensure bootstrap row exists at least once before app boot. Tests
  // re-bootstrap with `force` on every beforeEach to refresh after
  // TRUNCATE, but the first ever boot needs it too.
  await bootstrapAdminApiKey({
    client: pool,
    adminApiKey: TEST_ADMIN_API_KEY,
    force: true,
  });

  const registry = new ProviderRegistry(pool);
  const ledger = new PaymentLedger(pool, redis);

  // cosmos-pay — real HTTP wire, nock catches it on COSMOS_PAY_MOCK_HOST.
  const cosmos = new CosmosPayAdapter({
    baseUrl: COSMOS_PAY_MOCK_HOST,
    networkAssets: { "cosmos:noble-1": ["uusdc"] },
    estimatedFeeUsd: "0.0001",
  });
  await registry.register(cosmos, {
    config: { baseUrl: COSMOS_PAY_MOCK_HOST, estimatedFeeUsd: "0.0001" },
    staticCapabilities: [
      { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
    ],
  });

  // Coinbase CDP — real adapter incl. real JWT signing with a stub
  // signer (deterministic so nock matcher can stay loose on
  // Authorization). nock intercepts COINBASE_CDP_MOCK_HOST.
  const cdp = new CoinbaseCdpAdapter({
    baseUrl: COINBASE_CDP_MOCK_BASE,
    apiKeyName: "test-key-name",
    apiKeySecret: freshTestEd25519PrivateKeyPem(),
    signer: { sign: async () => "FAKE.JWT" },
    capabilities: [
      { network: "eip155:8453", asset: "0xUSDC", scheme: "exact" },
    ],
    estimatedFeeUsd: "0.001",
    monthlyHardCap: 1000,
  });
  await registry.register(cdp, {
    config: {
      baseUrl: COINBASE_CDP_MOCK_BASE,
      monthlyHardCap: 1000,
      estimatedFeeUsd: "0.001",
    },
    staticCapabilities: [
      { network: "eip155:8453", asset: "0xUSDC", scheme: "exact" },
    ],
  });

  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    ADMIN_API_KEY: TEST_ADMIN_API_KEY,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    RATE_LIMIT_MAX_PER_MINUTE: "1000000",
  });

  // Mutable holder so a test can set the metrics return value on
  // ctx without rebuilding the server.
  const metricsRef = {
    value: {
      totals: {
        payments: 0,
        settled: 0,
        failed: 0,
        pending: 0,
        successRate: 0,
      },
      providers: [],
      generatedAt: "2026-05-26T12:00:00Z",
    } as MetricsSummary,
  };

  const ctx: ServerContext = {
    config,
    registry,
    ledger,
    loadHealthSummaries: async (ids) =>
      loadHealthSummariesFromDb(pool, ids),
    loadMetrics: async () => metricsRef.value,
  };

  const app = await buildServer({ ctx, redis, enableLogger: false });

  return { app, pool, redis, ledger, registry, ctx, metricsRef };
}

export async function teardownStack(stack: IntegrationStack): Promise<void> {
  await stack.app.close();
  await stack.pool.end();
  stack.redis.disconnect();
  nock.cleanAll();
  nock.enableNetConnect();
}

/**
 * Per-test cleanup: empty every row that isn't a "fixture" (providers,
 * provider_capabilities) so the next test sees a fresh slate.
 * Re-bootstraps the admin api_key (since api_keys was truncated).
 */
export async function cleanState(stack: IntegrationStack): Promise<void> {
  await stack.pool.query(`
    TRUNCATE TABLE
      payment_attempts, routing_decisions, payments,
      provider_health_checks, merchant_policies,
      api_keys
    RESTART IDENTITY CASCADE
  `);
  await stack.redis.flushdb();
  await bootstrapAdminApiKey({
    client: stack.pool,
    adminApiKey: TEST_ADMIN_API_KEY,
    force: true,
  });
  nock.cleanAll();
}

async function loadHealthSummariesFromDb(
  pool: Pool,
  providerIds: ReadonlyArray<string>,
): Promise<Map<string, ProviderHealthSummary>> {
  const out = new Map<string, ProviderHealthSummary>();
  if (providerIds.length === 0) return out;
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
  const checkBy = new Map(lastCheck.rows.map((r) => [r.provider_id, r]));
  for (const id of providerIds) {
    const r = recentBy.get(id);
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
      successRate7d: 1,
      avgLatencyMs7d: 100,
      estimatedFeeUsd: id === "cosmos-pay" ? "0.0001" : "0.001",
    });
  }
  return out;
}

// ----------------- nock helpers ---------------------------------

export function nockCosmosSettleOnce(opts: {
  status?: number;
  body: object;
}): nock.Scope {
  return nock(COSMOS_PAY_MOCK_HOST)
    .post("/settle")
    .reply(opts.status ?? 200, opts.body);
}

export function nockCosmosVerifyOnce(opts: {
  status?: number;
  body: object;
}): nock.Scope {
  return nock(COSMOS_PAY_MOCK_HOST)
    .post("/verify")
    .reply(opts.status ?? 200, opts.body);
}

export function nockCdpSettleOnce(opts: {
  status?: number;
  body: object;
}): nock.Scope {
  return nock(COINBASE_CDP_MOCK_HOST)
    .post(`${COINBASE_CDP_MOCK_PATH}/settle`)
    .reply(opts.status ?? 200, opts.body);
}

export {
  ADMIN_API_KEY_ID,
  sha256ApiKeyHash,
  nock,
};
