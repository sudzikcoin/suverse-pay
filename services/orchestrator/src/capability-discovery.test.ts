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
import { CapabilityDiscoveryCron } from "./capability-discovery.js";
import { ProviderRegistry } from "./registry.js";
import { createTestStack, type TestStack } from "./_test-helpers.js";

let stack: TestStack;

function makeAdapter(
  id: string,
  discover?: () => Promise<DiscoveredCapability[]>,
): ProviderAdapter {
  const base: ProviderAdapter = {
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
      return { status: "healthy", checkedAt: new Date().toISOString() };
    },
  };
  if (discover !== undefined) {
    base.discoverCapabilities = discover;
  }
  return base;
}

beforeEach(async () => {
  stack = await createTestStack({ providerIds: [] });
});

afterEach(async () => {
  await stack.close();
});

describe("CapabilityDiscoveryCron — happy path", () => {
  it("upserts discovered rows on the first run", async () => {
    const reg = new ProviderRegistry(stack.pool);
    await reg.register(
      makeAdapter("cosmos-pay", async () => [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ]),
      {
        staticCapabilities: [
          { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
        ],
      },
    );

    const cron = new CapabilityDiscoveryCron(reg, stack.pool);
    await cron.runOnce();

    const rows = await stack.pool.query(
      `SELECT is_static, is_discovered, discovered_at FROM provider_capabilities
       WHERE provider_id = 'cosmos-pay'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.is_static).toBe(true);
    expect(rows.rows[0]!.is_discovered).toBe(true);
    expect(rows.rows[0]!.discovered_at).not.toBeNull();
  });

  it("adds new (discovered-only) capabilities not in static config", async () => {
    const reg = new ProviderRegistry(stack.pool);
    await reg.register(
      makeAdapter("cosmos-pay", async () => [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
        { network: "cosmos:grand-1", asset: "uusdc", scheme: "exact_cosmos_authz" }, // NEW
      ]),
      {
        staticCapabilities: [
          { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
        ],
      },
    );

    const cron = new CapabilityDiscoveryCron(reg, stack.pool);
    await cron.runOnce();

    const rows = await stack.pool.query(
      `SELECT network, is_static, is_discovered FROM provider_capabilities
       WHERE provider_id = 'cosmos-pay' ORDER BY network`,
    );
    expect(rows.rows).toHaveLength(2);
    const grand = rows.rows.find((r) => r.network === "cosmos:grand-1");
    expect(grand?.is_static).toBe(false);
    expect(grand?.is_discovered).toBe(true);
  });

  it("marks static rows superseded when discovery omits them", async () => {
    const reg = new ProviderRegistry(stack.pool);
    await reg.register(
      makeAdapter("cosmos-pay", async () => [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
        // grand-1 NOT in discovery now
      ]),
      {
        staticCapabilities: [
          { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
          { network: "cosmos:grand-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
        ],
      },
    );

    const cron = new CapabilityDiscoveryCron(reg, stack.pool);
    await cron.runOnce();

    const grand = await stack.pool.query(
      `SELECT superseded_at FROM provider_capabilities
       WHERE provider_id = 'cosmos-pay' AND network = 'cosmos:grand-1'`,
    );
    expect(grand.rows[0]!.superseded_at).not.toBeNull();
  });
});

describe("CapabilityDiscoveryCron — defensive behavior", () => {
  it("an empty discovery result does NOT supersede static rows", async () => {
    const reg = new ProviderRegistry(stack.pool);
    await reg.register(
      makeAdapter("p1", async () => []), // empty result
      {
        staticCapabilities: [
          { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
        ],
      },
    );

    const cron = new CapabilityDiscoveryCron(reg, stack.pool);
    await cron.runOnce();

    const rows = await stack.pool.query(
      `SELECT superseded_at FROM provider_capabilities WHERE provider_id = 'p1'`,
    );
    expect(rows.rows[0]!.superseded_at).toBeNull();
  });

  it("an adapter that throws is logged but doesn't crash the cron tick", async () => {
    const warnSpy = vi.fn();
    const reg = new ProviderRegistry(stack.pool);
    await reg.register(
      makeAdapter("p1", async () => {
        throw new Error("CDP outage");
      }),
      {
        staticCapabilities: [
          { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
        ],
      },
    );
    await reg.register(
      makeAdapter("p2", async () => [
        { network: "eip155:8453", asset: "0xUSDC", scheme: "exact" },
      ]),
      {
        staticCapabilities: [
          { network: "eip155:8453", asset: "0xUSDC", scheme: "exact" },
        ],
      },
    );
    const cron = new CapabilityDiscoveryCron(reg, stack.pool, 60_000, {
      info: () => {},
      warn: warnSpy,
      error: () => {},
    });
    await cron.runOnce();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("p1"),
      expect.any(Object),
    );
    // p2 still got its discovery written despite p1 failing.
    const p2 = await stack.pool.query(
      `SELECT is_discovered FROM provider_capabilities WHERE provider_id = 'p2'`,
    );
    expect(p2.rows[0]!.is_discovered).toBe(true);
  });

  it("adapters without discoverCapabilities are silently skipped", async () => {
    const reg = new ProviderRegistry(stack.pool);
    await reg.register(makeAdapter("p1"), {
      staticCapabilities: [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ],
    });
    const cron = new CapabilityDiscoveryCron(reg, stack.pool);
    await cron.runOnce(); // should not throw
    const rows = await stack.pool.query(
      `SELECT is_discovered FROM provider_capabilities WHERE provider_id = 'p1'`,
    );
    expect(rows.rows[0]!.is_discovered).toBe(false);
  });
});

describe("CapabilityDiscoveryCron — start/stop", () => {
  it("start() schedules ticks and stop() halts them", async () => {
    const reg = new ProviderRegistry(stack.pool);
    const spy = vi.fn(async () => []);
    await reg.register(makeAdapter("p1", spy), { staticCapabilities: [] });

    const cron = new CapabilityDiscoveryCron(reg, stack.pool, 50);
    cron.start();
    await new Promise((r) => setTimeout(r, 175));
    cron.stop();
    // At least 2 invocations (immediate + 1 timer tick).
    const callsAfterStop = spy.mock.calls.length;
    expect(callsAfterStop).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 100));
    expect(spy.mock.calls.length).toBe(callsAfterStop); // no more after stop
  });
});
