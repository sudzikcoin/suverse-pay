import type {
  DiscoveredCapability,
  GetStatusHints,
  HealthStatus,
  ProviderAdapter,
  QuoteRequest,
  QuoteResponse,
  SettleOptions,
  SettleRequest,
  SettleResponse,
  StatusResponse,
  SupportQuery,
  VerifyRequest,
  VerifyResponse,
} from "@suverse-pay/core-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HealthCheckCron } from "./health-check.js";
import { ProviderRegistry } from "./registry.js";
import { createTestStack, type TestStack } from "./_test-helpers.js";

let stack: TestStack;

function makeAdapter(
  id: string,
  health: HealthStatus | Error,
): ProviderAdapter {
  return {
    id,
    displayName: id,
    async supports(_q: SupportQuery) {
      return { supported: true };
    },
    async quote(req: QuoteRequest): Promise<QuoteResponse> {
      return {
        providerId: id,
        network: req.network,
        asset: req.asset,
        amount: req.amount,
        estimatedFeeUsd: "0.001",
        estimatedLatencyMs: 100,
        scheme: req.scheme,
        source: "synthetic",
      };
    },
    async verify(_req: VerifyRequest): Promise<VerifyResponse> {
      return { valid: true, providerId: id, verifiedAt: new Date().toISOString() };
    },
    async settle(
      _req: SettleRequest,
      _o?: SettleOptions,
    ): Promise<SettleResponse> {
      return {
        settled: true,
        providerId: id,
        network: "cosmos:noble-1",
        asset: "uusdc",
        amount: "10000",
      };
    },
    async getStatus(_id: string, _h?: GetStatusHints): Promise<StatusResponse> {
      return { providerId: id, providerPaymentId: "x", status: "settled" };
    },
    async healthCheck(): Promise<HealthStatus> {
      if (health instanceof Error) throw health;
      return health;
    },
    async discoverCapabilities(): Promise<DiscoveredCapability[]> {
      return [];
    },
  };
}

beforeEach(async () => {
  stack = await createTestStack({ providerIds: [] });
});

afterEach(async () => {
  await stack.close();
});

describe("HealthCheckCron", () => {
  it("records a healthy result", async () => {
    const reg = new ProviderRegistry(stack.pool);
    await reg.register(
      makeAdapter("p1", {
        status: "healthy",
        latencyMs: 50,
        checkedAt: new Date().toISOString(),
      }),
      { staticCapabilities: [] },
    );
    const cron = new HealthCheckCron(reg, stack.pool);
    await cron.runOnce();
    const rows = await stack.pool.query(
      `SELECT status, latency_ms FROM provider_health_checks WHERE provider_id = 'p1'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.status).toBe("healthy");
    expect(rows.rows[0]!.latency_ms).toBe(50);
  });

  it("records a down result with the error message", async () => {
    const reg = new ProviderRegistry(stack.pool);
    await reg.register(
      makeAdapter("p1", {
        status: "down",
        latencyMs: 0,
        error: "HTTP 503",
        checkedAt: new Date().toISOString(),
      }),
      { staticCapabilities: [] },
    );
    const cron = new HealthCheckCron(reg, stack.pool);
    await cron.runOnce();
    const rows = await stack.pool.query(
      `SELECT status, error FROM provider_health_checks WHERE provider_id = 'p1'`,
    );
    expect(rows.rows[0]!.status).toBe("down");
    expect(rows.rows[0]!.error).toBe("HTTP 503");
  });

  it("a thrown healthCheck is recorded as down + logged", async () => {
    const warnSpy = vi.fn();
    const reg = new ProviderRegistry(stack.pool);
    await reg.register(makeAdapter("p1", new Error("ECONNREFUSED")), {
      staticCapabilities: [],
    });
    const cron = new HealthCheckCron(reg, stack.pool, 60_000, {
      info: () => {},
      warn: warnSpy,
      error: () => {},
    });
    await cron.runOnce();
    const rows = await stack.pool.query(
      `SELECT status, error FROM provider_health_checks WHERE provider_id = 'p1'`,
    );
    expect(rows.rows[0]!.status).toBe("down");
    expect(rows.rows[0]!.error).toContain("ECONNREFUSED");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("disabled providers are skipped", async () => {
    const reg = new ProviderRegistry(stack.pool);
    await reg.register(
      makeAdapter("p1", {
        status: "healthy",
        checkedAt: new Date().toISOString(),
      }),
      { staticCapabilities: [], enabled: false },
    );
    const cron = new HealthCheckCron(reg, stack.pool);
    await cron.runOnce();
    const rows = await stack.pool.query(
      `SELECT id FROM provider_health_checks WHERE provider_id = 'p1'`,
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("start() ticks on the configured interval; stop() halts further ticks", async () => {
    const reg = new ProviderRegistry(stack.pool);
    await reg.register(
      makeAdapter("p1", {
        status: "healthy",
        checkedAt: new Date().toISOString(),
      }),
      { staticCapabilities: [] },
    );
    const cron = new HealthCheckCron(reg, stack.pool, 50);
    cron.start();
    await new Promise((r) => setTimeout(r, 175));
    cron.stop();
    const count1 = (
      await stack.pool.query(
        `SELECT COUNT(*)::int AS c FROM provider_health_checks WHERE provider_id = 'p1'`,
      )
    ).rows[0]!.c;
    expect(count1).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 100));
    const count2 = (
      await stack.pool.query(
        `SELECT COUNT(*)::int AS c FROM provider_health_checks WHERE provider_id = 'p1'`,
      )
    ).rows[0]!.c;
    expect(count2).toBe(count1); // no new rows after stop
  });
});
