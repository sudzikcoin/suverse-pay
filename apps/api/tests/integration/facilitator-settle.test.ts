import { CosmosPayAdapter } from "@suverse-pay/adapter-cosmos-pay";
import {
  bootstrapAdminApiKey,
  createResourceKey,
  revokeResourceKey,
} from "@suverse-pay/db";
import { FacilitatorRateLimiter } from "@suverse-pay/facilitator";
import {
  PaymentLedger,
  ProviderRegistry,
  type ProviderHealthSummary,
} from "@suverse-pay/orchestrator";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import nock from "nock";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import type { MetricsSummary, ServerContext } from "../../src/context.js";
import { buildServer } from "../../src/server.js";

const TEST_ADMIN_API_KEY = "facilitator-itest-admin";
const COSMOS_PAY_MOCK_HOST = "http://cosmos-pay-itest.mock.test";
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://suverse:suverse@localhost:5433/suverse_pay";
const redisUrl = process.env.TEST_REDIS_URL ?? "redis://localhost:6380";

interface Stack {
  app: FastifyInstance;
  pool: Pool;
  redis: Redis;
  resourceKey: { id: string; plaintext: string };
}

let stack: Stack | null = null;

beforeAll(async () => {
  nock.disableNetConnect();
  nock.enableNetConnect((host) => /^(127\.0\.0\.1|::1|localhost)/.test(host));
  stack = await buildStack();
});

afterAll(async () => {
  if (stack !== null) {
    await stack.app.close();
    await stack.pool.end();
    stack.redis.disconnect();
  }
  nock.cleanAll();
  nock.enableNetConnect();
});

beforeEach(async () => {
  if (stack === null) throw new Error("stack not initialized");
  // Reset state per test so payment/idempotency rows from one test
  // don't shadow the next.
  await stack.pool.query(`
    TRUNCATE TABLE
      facilitator_failover_events, facilitator_payments, resource_api_keys,
      payment_attempts, routing_decisions, payments,
      provider_health_checks, merchant_policies, api_keys
    RESTART IDENTITY CASCADE
  `);
  await stack.redis.flushdb();
  await bootstrapAdminApiKey({
    client: stack.pool,
    adminApiKey: TEST_ADMIN_API_KEY,
    force: true,
  });
  const created = await createResourceKey({
    client: stack.pool,
    label: "itest-key",
    rateLimitPerMinute: 60,
    monthlySettleCap: null,
  });
  stack.resourceKey = { id: created.id, plaintext: created.plaintext };
  nock.cleanAll();
});

async function buildStack(): Promise<Stack> {
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

  await bootstrapAdminApiKey({
    client: pool,
    adminApiKey: TEST_ADMIN_API_KEY,
    force: true,
  });

  const registry = new ProviderRegistry(pool);
  const ledger = new PaymentLedger(pool, redis);

  // cosmos-pay against grand-1 — matches the static routing config.
  const cosmos = new CosmosPayAdapter({
    baseUrl: COSMOS_PAY_MOCK_HOST,
    networkAssets: { "cosmos:grand-1": ["uusdc"] },
    estimatedFeeUsd: "0.0001",
  });
  await registry.register(cosmos, {
    config: { baseUrl: COSMOS_PAY_MOCK_HOST, estimatedFeeUsd: "0.0001" },
    staticCapabilities: [
      { network: "cosmos:grand-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
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

  const facilitatorRateLimiter = new FacilitatorRateLimiter({ redis });
  const ctx: ServerContext = {
    config,
    registry,
    ledger,
    pool,
    facilitatorRateLimiter,
    loadHealthSummaries: async (ids) => emptyHealthSummaries(ids),
    loadMetrics: async () =>
      ({
        totals: { payments: 0, settled: 0, failed: 0, pending: 0, successRate: 0 },
        providers: [],
        facilitator: {
          paymentsByResourceKey: [],
          paymentsByNetwork: [],
          adapterSelections: [],
          failoverEvents: 0,
        },
        generatedAt: "2026-05-28T00:00:00Z",
      }) as MetricsSummary,
  };
  const app = await buildServer({ ctx, redis, enableLogger: false });
  return {
    app,
    pool,
    redis,
    resourceKey: { id: "", plaintext: "" },
  };
}

function emptyHealthSummaries(
  ids: ReadonlyArray<string>,
): Map<string, ProviderHealthSummary> {
  const out = new Map<string, ProviderHealthSummary>();
  for (const id of ids) {
    out.set(id, {
      providerId: id,
      recentAttempts: 0,
      recentFailures: 0,
      lastCheck: null,
      successRate7d: 1,
      avgLatencyMs7d: 100,
      estimatedFeeUsd: "0.0001",
    });
  }
  return out;
}

function cosmosPayload(): unknown {
  return {
    x402Version: 2,
    scheme: "exact_cosmos_authz",
    network: "cosmos:grand-1",
    payload: {
      from: "noble1payer",
      publicKey: "pk",
      signature: "sig",
      authorization: {
        from: "noble1payer",
        to: "noble1recipient",
        denom: "uusdc",
        amount: "10000",
        nonce: "0xunique-nonce-001",
        validAfter: 0,
        validBefore: 9_999_999_999,
        resource: "https://example.com/x",
        chainId: "grand-1",
      },
    },
  };
}

function cosmosRequirements(): unknown {
  return {
    scheme: "exact_cosmos_authz",
    network: "cosmos:grand-1",
    maxAmountRequired: "10000",
    asset: "uusdc",
    payTo: "noble1recipient",
    resource: "https://example.com/x",
    maxTimeoutSeconds: 60,
    extra: { facilitator: "noble1grantee", chainId: "grand-1" },
  };
}

describe("POST /facilitator/settle — auth + rate limit + idempotency + persistence", () => {
  it("401 when Authorization header is missing", async () => {
    const res = await stack!.app.inject({
      method: "POST",
      url: "/facilitator/settle",
      payload: {
        paymentPayload: cosmosPayload(),
        paymentRequirements: cosmosRequirements(),
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("401 when the resource key is unknown", async () => {
    const res = await stack!.app.inject({
      method: "POST",
      url: "/facilitator/settle",
      headers: { authorization: "Bearer 0".repeat(20) },
      payload: {
        paymentPayload: cosmosPayload(),
        paymentRequirements: cosmosRequirements(),
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("happy path: routes to cosmos-pay, persists row, returns x402-spec response", async () => {
    nock(COSMOS_PAY_MOCK_HOST).post("/settle").reply(200, {
      success: true,
      transaction: "DEADBEEF",
      network: "cosmos:grand-1",
      payer: "noble1payer",
    });
    const res = await stack!.app.inject({
      method: "POST",
      url: "/facilitator/settle",
      headers: { authorization: `Bearer ${stack!.resourceKey.plaintext}` },
      payload: {
        paymentPayload: cosmosPayload(),
        paymentRequirements: cosmosRequirements(),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.transaction).toBe("DEADBEEF");
    expect(body.network).toBe("cosmos:grand-1");

    // Row was written to facilitator_payments.
    const rows = await stack!.pool.query<{ status: string; tx_hash: string; adapter_used: string }>(
      `SELECT status, tx_hash, adapter_used FROM facilitator_payments`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.status).toBe("settled");
    expect(rows.rows[0]!.tx_hash).toBe("DEADBEEF");
    expect(rows.rows[0]!.adapter_used).toBe("cosmos-pay");
  });

  it("idempotency: replay with same (resource key + payload nonce) within an hour returns the same record without re-broadcasting", async () => {
    nock(COSMOS_PAY_MOCK_HOST).post("/settle").once().reply(200, {
      success: true,
      transaction: "FIRSTTX",
      network: "cosmos:grand-1",
      payer: "noble1payer",
    });
    const first = await stack!.app.inject({
      method: "POST",
      url: "/facilitator/settle",
      headers: { authorization: `Bearer ${stack!.resourceKey.plaintext}` },
      payload: {
        paymentPayload: cosmosPayload(),
        paymentRequirements: cosmosRequirements(),
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().transaction).toBe("FIRSTTX");

    // Second call must NOT hit cosmos-pay (nock only allowed once,
    // so a second call would fail with "no match"). The handler must
    // short-circuit via the (resource_key_id, idempotency_key) row.
    const second = await stack!.app.inject({
      method: "POST",
      url: "/facilitator/settle",
      headers: { authorization: `Bearer ${stack!.resourceKey.plaintext}` },
      payload: {
        paymentPayload: cosmosPayload(),
        paymentRequirements: cosmosRequirements(),
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().transaction).toBe("FIRSTTX");

    // Exactly one row in facilitator_payments — the conflict was
    // resolved by ON CONFLICT DO NOTHING + the existing-row fetch.
    const count = await stack!.pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM facilitator_payments`,
    );
    expect(Number(count.rows[0]!.n)).toBe(1);
  });

  it("two different resource keys settling the same payload get DIFFERENT facilitator_payments rows (per-tenant idempotency namespace)", async () => {
    const second = await createResourceKey({
      client: stack!.pool,
      label: "itest-key-2",
      rateLimitPerMinute: 60,
      monthlySettleCap: null,
    });
    nock(COSMOS_PAY_MOCK_HOST).post("/settle").twice().reply(200, {
      success: true,
      transaction: "TWICE",
      network: "cosmos:grand-1",
      payer: "noble1payer",
    });
    const tenantA = await stack!.app.inject({
      method: "POST",
      url: "/facilitator/settle",
      headers: { authorization: `Bearer ${stack!.resourceKey.plaintext}` },
      payload: {
        paymentPayload: cosmosPayload(),
        paymentRequirements: cosmosRequirements(),
      },
    });
    const tenantB = await stack!.app.inject({
      method: "POST",
      url: "/facilitator/settle",
      headers: { authorization: `Bearer ${second.plaintext}` },
      payload: {
        paymentPayload: cosmosPayload(),
        paymentRequirements: cosmosRequirements(),
      },
    });
    expect(tenantA.statusCode).toBe(200);
    expect(tenantB.statusCode).toBe(200);
    const rows = await stack!.pool.query<{ resource_key_id: string }>(
      `SELECT resource_key_id FROM facilitator_payments`,
    );
    // Two rows — one per resource key. If we accidentally shared
    // idempotency namespace across tenants, the second insert would
    // have ON CONFLICT'd to a single row.
    expect(rows.rows).toHaveLength(2);
    const tenantIds = new Set(rows.rows.map((r) => r.resource_key_id));
    expect(tenantIds.size).toBe(2);
  });

  it("revoked resource key → 401", async () => {
    await revokeResourceKey({
      client: stack!.pool,
      id: stack!.resourceKey.id,
    });
    const res = await stack!.app.inject({
      method: "POST",
      url: "/facilitator/settle",
      headers: { authorization: `Bearer ${stack!.resourceKey.plaintext}` },
      payload: {
        paymentPayload: cosmosPayload(),
        paymentRequirements: cosmosRequirements(),
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rate limited: 61st request in a minute returns 429 with Retry-After info in the message", async () => {
    // Create a tight-quota key for this test.
    const tight = await createResourceKey({
      client: stack!.pool,
      label: "tight",
      rateLimitPerMinute: 1, // exhausts after the first request
      monthlySettleCap: null,
    });
    nock(COSMOS_PAY_MOCK_HOST).post("/settle").reply(200, {
      success: true,
      transaction: "T1",
      network: "cosmos:grand-1",
    });
    const ok = await stack!.app.inject({
      method: "POST",
      url: "/facilitator/settle",
      headers: { authorization: `Bearer ${tight.plaintext}` },
      payload: {
        paymentPayload: cosmosPayload(),
        paymentRequirements: cosmosRequirements(),
      },
    });
    expect(ok.statusCode).toBe(200);
    const limited = await stack!.app.inject({
      method: "POST",
      url: "/facilitator/settle",
      headers: { authorization: `Bearer ${tight.plaintext}` },
      payload: {
        paymentPayload: cosmosPayload(),
        paymentRequirements: cosmosRequirements(),
      },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("rate_limited");
  });

  it("/facilitator/settle for an unsupported route returns 400 route_unsupported", async () => {
    const res = await stack!.app.inject({
      method: "POST",
      url: "/facilitator/settle",
      headers: { authorization: `Bearer ${stack!.resourceKey.plaintext}` },
      payload: {
        paymentPayload: {
          x402Version: 2,
          scheme: "exact",
          network: "eip155:99999",
          payload: {
            signature: "0xsig",
            authorization: { from: "0xpayer", nonce: "0xnonce" },
          },
        },
        paymentRequirements: {
          scheme: "exact",
          network: "eip155:99999",
          maxAmountRequired: "10000",
          asset: "0xUSDC",
          payTo: "0xrecipient",
          resource: "https://example.com/x",
          maxTimeoutSeconds: 60,
          extra: { name: "USDC", version: "2" },
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("route_unsupported");
  });
});
