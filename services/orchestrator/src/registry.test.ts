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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderRegistry } from "./registry.js";
import { createTestStack, type TestStack } from "./_test-helpers.js";

let stack: TestStack;

function makeAdapter(id: string): ProviderAdapter {
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
      return { status: "healthy", checkedAt: new Date().toISOString() };
    },
    async discoverCapabilities(): Promise<DiscoveredCapability[]> {
      return [];
    },
  };
}

beforeEach(async () => {
  // Empty providerIds — registry tests do the seeding themselves.
  stack = await createTestStack({ providerIds: [] });
});

afterEach(async () => {
  await stack.close();
});

describe("ProviderRegistry.register", () => {
  it("upserts the providers row + capability rows on first call", async () => {
    const reg = new ProviderRegistry(stack.pool);
    await reg.register(makeAdapter("p1"), {
      displayName: "Provider One",
      config: { baseUrl: "https://x.test" },
      staticCapabilities: [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ],
    });

    const providerRows = await stack.pool.query(
      `SELECT id, display_name, enabled FROM providers WHERE id = 'p1'`,
    );
    expect(providerRows.rows).toHaveLength(1);
    expect(providerRows.rows[0]!.display_name).toBe("Provider One");
    expect(providerRows.rows[0]!.enabled).toBe(true);

    const capRows = await stack.pool.query(
      `SELECT network, asset, scheme, is_static FROM provider_capabilities WHERE provider_id = 'p1'`,
    );
    expect(capRows.rows).toHaveLength(1);
    expect(capRows.rows[0]!.is_static).toBe(true);
  });

  it("re-registering is idempotent (no row duplication)", async () => {
    const reg = new ProviderRegistry(stack.pool);
    const adapter = makeAdapter("p1");
    await reg.register(adapter, {
      staticCapabilities: [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ],
    });
    await reg.register(adapter, {
      displayName: "Renamed",
      staticCapabilities: [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ],
    });
    const rows = await stack.pool.query(`SELECT id, display_name FROM providers`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.display_name).toBe("Renamed");
  });

  it("list() returns registered adapters in insertion order", async () => {
    const reg = new ProviderRegistry(stack.pool);
    await reg.register(makeAdapter("a"), { staticCapabilities: [] });
    await reg.register(makeAdapter("b"), { staticCapabilities: [] });
    expect(reg.list().map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("getById returns undefined for unknown ids", async () => {
    const reg = new ProviderRegistry(stack.pool);
    expect(reg.getById("none")).toBeUndefined();
  });

  it("enabled() filters by the enabled flag", async () => {
    const reg = new ProviderRegistry(stack.pool);
    await reg.register(makeAdapter("a"), { staticCapabilities: [], enabled: true });
    await reg.register(makeAdapter("b"), { staticCapabilities: [], enabled: false });
    expect(reg.enabled().map((p) => p.id)).toEqual(["a"]);
  });
});

describe("ProviderRegistry.setEnabled", () => {
  it("updates the in-memory map + the DB row", async () => {
    const reg = new ProviderRegistry(stack.pool);
    await reg.register(makeAdapter("a"), { staticCapabilities: [] });
    await reg.setEnabled("a", false);
    expect(reg.getById("a")?.enabled).toBe(false);
    const row = await stack.pool.query(`SELECT enabled FROM providers WHERE id = 'a'`);
    expect(row.rows[0]!.enabled).toBe(false);
  });

  it("throws for an unknown provider id", async () => {
    const reg = new ProviderRegistry(stack.pool);
    await expect(reg.setEnabled("nope", false)).rejects.toThrow(/unknown provider/);
  });
});

describe("ProviderRegistry.listCapabilities", () => {
  it("returns active rows and skips superseded ones", async () => {
    const reg = new ProviderRegistry(stack.pool);
    await reg.register(makeAdapter("p1"), {
      staticCapabilities: [
        { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
        { network: "cosmos:grand-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
      ],
    });
    // Mark one row superseded.
    await stack.pool.query(
      `UPDATE provider_capabilities SET superseded_at = NOW()
       WHERE provider_id = 'p1' AND network = 'cosmos:grand-1'`,
    );
    const caps = await reg.listCapabilities("p1");
    expect(caps).toHaveLength(1);
    expect(caps[0]!.network).toBe("cosmos:noble-1");
  });
});
