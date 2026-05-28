import type {
  DiscoveredCapability,
  GetStatusHints,
  HealthStatus,
  PaymentRequirements,
  PaymentPayload,
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
import type {
  AttemptOutcome,
  CapabilityRow,
  CreateOrFetchResult,
  PaymentRecord,
  ProviderHealthSummary,
  RegisteredProvider,
  RoutingDecision,
} from "@suverse-pay/orchestrator";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { MetricsSummary, ServerContext } from "../context.js";
import { sha256Hex, ADMIN_API_KEY_ID } from "../plugins/auth.js";
import { buildServer } from "../server.js";

export const TEST_API_KEY = "test-admin-key";
export const TEST_API_KEY_BEARER = `Bearer ${TEST_API_KEY}`;

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: "test",
    logLevel: "silent",
    apiPort: 3000,
    apiHost: "127.0.0.1",
    adminApiKey: TEST_API_KEY,
    databaseUrl: "postgres://test",
    redisUrl: "redis://test",
    rateLimitMaxPerMinute: 1_000_000,
    cosmosPayBaseUrl: "http://localhost:8402",
    coinbaseCdpMonthlyHardCap: 5000,
    capabilityDiscoveryIntervalMs: 7_200_000,
    healthCheckIntervalMs: 30_000,
    ...overrides,
  };
}

/**
 * Programmable provider adapter — every method has a default implementation
 * but every call is also recorded in `calls` for assertions.
 */
export interface FakeProviderOptions {
  id: string;
  displayName?: string;
  supports?: (q: SupportQuery) => SupportResult;
  quote?: (req: QuoteRequest) => QuoteResponse;
  verify?: (req: VerifyRequest) => VerifyResponse | Promise<VerifyResponse>;
  settle?: (
    req: SettleRequest,
    opts?: SettleOptions,
  ) => SettleResponse | Promise<SettleResponse>;
  getStatus?: (id: string, h?: GetStatusHints) => StatusResponse;
  healthCheck?: () => HealthStatus;
  discoverCapabilities?: () => DiscoveredCapability[];
}

export interface FakeProvider {
  adapter: ProviderAdapter;
  calls: {
    supports: SupportQuery[];
    quote: QuoteRequest[];
    verify: VerifyRequest[];
    settle: Array<{ req: SettleRequest; opts: SettleOptions | undefined }>;
  };
}

export function makeFakeProvider(opts: FakeProviderOptions): FakeProvider {
  const calls: FakeProvider["calls"] = {
    supports: [],
    quote: [],
    verify: [],
    settle: [],
  };
  const adapter: ProviderAdapter = {
    id: opts.id,
    displayName: opts.displayName ?? opts.id,
    async supports(req) {
      calls.supports.push(req);
      return opts.supports?.(req) ?? { supported: true };
    },
    async quote(req) {
      calls.quote.push(req);
      return (
        opts.quote?.(req) ?? {
          providerId: opts.id,
          network: req.network,
          asset: req.asset,
          amount: req.amount,
          estimatedFeeUsd: "0.001",
          estimatedLatencyMs: 100,
          scheme: req.scheme,
          source: "synthetic",
        }
      );
    },
    async verify(req) {
      calls.verify.push(req);
      return (
        (await opts.verify?.(req)) ?? {
          valid: true,
          providerId: opts.id,
          verifiedAt: "2026-05-26T12:00:00Z",
        }
      );
    },
    async settle(req, settleOpts) {
      calls.settle.push({ req, opts: settleOpts });
      return (
        (await opts.settle?.(req, settleOpts)) ?? {
          settled: true,
          providerId: opts.id,
          network: req.paymentRequirements.network,
          asset: req.paymentRequirements.asset,
          amount: req.paymentRequirements.maxAmountRequired,
          txHash: "0xMOCK",
        }
      );
    },
    async getStatus(id, h) {
      return (
        opts.getStatus?.(id, h) ?? {
          providerId: opts.id,
          providerPaymentId: id,
          status: "settled",
        }
      );
    },
    async healthCheck() {
      return (
        opts.healthCheck?.() ?? {
          status: "healthy",
          checkedAt: "2026-05-26T12:00:00Z",
        }
      );
    },
    async discoverCapabilities() {
      return opts.discoverCapabilities?.() ?? [];
    },
  };
  return { adapter, calls };
}

export interface MockRegistry {
  list(): RegisteredProvider[];
  enabled(): RegisteredProvider[];
  getById(id: string): RegisteredProvider | undefined;
  listCapabilities(providerId: string): Promise<CapabilityRow[]>;
}

export function makeRegistry(
  providers: ReadonlyArray<{
    fake: FakeProvider;
    enabled?: boolean;
    capabilities?: ReadonlyArray<CapabilityRow>;
  }>,
): MockRegistry {
  const map = new Map<
    string,
    { reg: RegisteredProvider; caps: ReadonlyArray<CapabilityRow> }
  >();
  for (const p of providers) {
    const reg: RegisteredProvider = {
      id: p.fake.adapter.id,
      displayName: p.fake.adapter.displayName,
      enabled: p.enabled ?? true,
      config: {},
      adapter: p.fake.adapter,
    };
    map.set(reg.id, {
      reg,
      caps:
        p.capabilities ?? [
          {
            providerId: reg.id,
            network: "cosmos:noble-1",
            asset: "uusdc",
            scheme: "exact_cosmos_authz",
            isStatic: true,
            isDiscovered: false,
            discoveredAt: null,
            supersededAt: null,
          },
        ],
    });
  }
  return {
    list: () => Array.from(map.values()).map((v) => v.reg),
    enabled: () =>
      Array.from(map.values())
        .filter((v) => v.reg.enabled)
        .map((v) => v.reg),
    getById: (id) => map.get(id)?.reg,
    listCapabilities: async (id) => map.get(id)?.caps.slice() ?? [],
  };
}

/**
 * In-memory PaymentLedger fake. Implements the same surface
 * `apps/api` consumes, with no DB or Redis.
 */
export class FakeLedger {
  private nextId = 1;
  private nextAttemptNumber = 1;
  payments = new Map<string, PaymentRecord>();
  paymentsByIdem = new Map<string, string>(); // `${apiKey}:${idem}` -> paymentId
  attemptsByPayment = new Map<string, AttemptOutcome[]>();
  routingDecisions = new Map<string, RoutingDecision>();
  releasedLocks: string[] = [];

  reset(): void {
    this.nextId = 1;
    this.payments.clear();
    this.paymentsByIdem.clear();
    this.attemptsByPayment.clear();
    this.routingDecisions.clear();
    this.releasedLocks = [];
  }

  async createOrFetchPayment(input: {
    apiKeyId: string;
    idempotencyKey?: string | undefined;
    initialRow: {
      network: string;
      asset: string;
      amount: string;
      recipient: string;
      resource?: string;
      requestBody: unknown;
    };
  }): Promise<CreateOrFetchResult> {
    if (input.idempotencyKey !== undefined) {
      const k = `${input.apiKeyId}:${input.idempotencyKey}`;
      const existing = this.paymentsByIdem.get(k);
      if (existing !== undefined) {
        return {
          payment: this.payments.get(existing)!,
          isNew: false,
          lockKey: null,
        };
      }
      const paymentId = `pay_${this.nextId++}`;
      const lockKey = `idem:${k}`;
      const row: PaymentRecord = {
        paymentId,
        apiKeyId: input.apiKeyId,
        idempotencyKey: input.idempotencyKey,
        status: "pending",
        network: input.initialRow.network as PaymentRecord["network"],
        asset: input.initialRow.asset,
        amount: input.initialRow.amount,
        recipient: input.initialRow.recipient,
        ...(input.initialRow.resource !== undefined
          ? { resource: input.initialRow.resource }
          : {}),
        createdAt: new Date("2026-05-26T12:00:00Z"),
      };
      this.payments.set(paymentId, row);
      this.paymentsByIdem.set(k, paymentId);
      return { payment: row, isNew: true, lockKey };
    }
    const paymentId = `pay_${this.nextId++}`;
    const row: PaymentRecord = {
      paymentId,
      apiKeyId: input.apiKeyId,
      status: "pending",
      network: input.initialRow.network as PaymentRecord["network"],
      asset: input.initialRow.asset,
      amount: input.initialRow.amount,
      recipient: input.initialRow.recipient,
      createdAt: new Date("2026-05-26T12:00:00Z"),
    };
    this.payments.set(paymentId, row);
    return { payment: row, isNew: true, lockKey: null };
  }

  async releaseLock(lockKey: string): Promise<void> {
    this.releasedLocks.push(lockKey);
  }

  async findById(paymentId: string): Promise<PaymentRecord | null> {
    return this.payments.get(paymentId) ?? null;
  }

  async findByIdempotencyKey(
    apiKeyId: string,
    idempotencyKey: string,
  ): Promise<PaymentRecord | null> {
    const id = this.paymentsByIdem.get(`${apiKeyId}:${idempotencyKey}`);
    return id !== undefined ? (this.payments.get(id) ?? null) : null;
  }

  async startAttempt(
    paymentId: string,
    providerId: string,
    attemptNumber: number,
  ): Promise<void> {
    const list = this.attemptsByPayment.get(paymentId) ?? [];
    list.push({
      attemptNumber,
      providerId,
      startedAt: new Date(),
      completedAt: new Date(),
      outcome: "pending" as AttemptOutcome["outcome"],
      latencyMs: 0,
    });
    this.attemptsByPayment.set(paymentId, list);
    void this.nextAttemptNumber;
  }

  async finishAttempt(
    paymentId: string,
    attemptNumber: number,
    outcome: AttemptOutcome,
  ): Promise<void> {
    const list = this.attemptsByPayment.get(paymentId);
    if (list === undefined) return;
    const idx = list.findIndex((a) => a.attemptNumber === attemptNumber);
    if (idx >= 0) list[idx] = outcome;
  }

  async listAttempts(paymentId: string): Promise<AttemptOutcome[]> {
    return (this.attemptsByPayment.get(paymentId) ?? []).slice();
  }

  async finalizePayment(
    paymentId: string,
    fields: Partial<PaymentRecord> & {
      status: PaymentRecord["status"];
      settledAt?: Date;
    },
  ): Promise<void> {
    const existing = this.payments.get(paymentId);
    if (existing === undefined) return;
    this.payments.set(paymentId, { ...existing, ...fields });
  }

  async recordRoutingDecision(
    paymentId: string,
    decision: RoutingDecision,
  ): Promise<void> {
    this.routingDecisions.set(paymentId, decision);
  }
}

export interface TestServerHandles {
  app: FastifyInstance;
  ctx: ServerContext;
  registry: MockRegistry;
  ledger: FakeLedger;
}

export async function makeTestServer(opts: {
  providers?: ReadonlyArray<{
    fake: FakeProvider;
    enabled?: boolean;
    capabilities?: ReadonlyArray<CapabilityRow>;
  }>;
  healthSummaries?: ReadonlyMap<string, ProviderHealthSummary>;
  metrics?: MetricsSummary;
  config?: Partial<Config>;
}): Promise<TestServerHandles> {
  const ledger = new FakeLedger();
  const registry = makeRegistry(opts.providers ?? []);
  const ctx: ServerContext = {
    config: makeConfig(opts.config),
    // The orchestrator's class shapes are duck-typed against the
    // route handlers; the in-memory fakes implement the same surface
    // the routes consume.
    registry: registry as unknown as ServerContext["registry"],
    ledger: ledger as unknown as ServerContext["ledger"],
    loadHealthSummaries: async (ids) => {
      const out = new Map<string, ProviderHealthSummary>();
      for (const id of ids) {
        const s = opts.healthSummaries?.get(id);
        if (s !== undefined) out.set(id, s);
      }
      return out;
    },
    loadMetrics: async () =>
      opts.metrics ?? {
        totals: { payments: 0, settled: 0, failed: 0, pending: 0, successRate: 0 },
        providers: [],
        facilitator: {
          paymentsByResourceKey: [],
          paymentsByNetwork: [],
          adapterSelections: [],
          failoverEvents: 0,
        },
        generatedAt: "2026-05-26T12:00:00Z",
      },
    now: () => new Date("2026-05-26T12:00:00Z"),
  };
  const app = await buildServer({ ctx, redis: null, enableLogger: false });
  return { app, ctx, registry, ledger };
}

export function paymentPayload(): PaymentPayload {
  return {
    x402Version: 2,
    scheme: "exact_cosmos_authz",
    network: "cosmos:noble-1",
    payload: { fake: true },
  };
}

export function paymentRequirements(): PaymentRequirements {
  return {
    scheme: "exact_cosmos_authz",
    network: "cosmos:noble-1",
    maxAmountRequired: "10000",
    asset: "uusdc",
    payTo: "noble1recipient",
    resource: "https://example.com/api/widget",
  };
}

// Re-exports for convenience
export { sha256Hex, ADMIN_API_KEY_ID };
