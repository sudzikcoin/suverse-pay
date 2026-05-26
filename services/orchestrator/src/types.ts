import type {
  Caip2,
  DiscoveredCapability,
  ErrorCode,
  HealthState,
  MerchantPolicy,
  OptimizeStrategy,
  PaymentAttemptOutcome,
  PaymentStatus,
  ProviderAdapter,
  SettleRequest,
} from "@suverse-pay/core-types";

/**
 * Lightweight structural logger interface used across the orchestrator
 * so callers (apps/api) can plug in pino / pino-pretty / a noop without
 * the orchestrator pulling in a logging dep itself.
 */
export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export const NOOP_LOGGER: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * An adapter registered in the orchestrator together with the metadata
 * that lives in the `providers` table. Construction-time information
 * (id, displayName) comes from the adapter; runtime config (api keys,
 * base URLs, fee estimates) lives in the DB row.
 */
export interface RegisteredProvider {
  readonly id: string;
  readonly displayName: string;
  readonly adapter: ProviderAdapter;
  readonly config: Record<string, unknown>;
  readonly enabled: boolean;
}

/**
 * Routing decision inputs: the network/asset/scheme tuple plus the
 * resolved merchant policy.
 */
export interface RoutingContext {
  network: Caip2;
  asset: string;
  scheme: string;
  policy: MerchantPolicy;
}

/**
 * Per-provider health summary the router consumes. Pure data — no DB
 * coupling. Callers (registry-with-DB / health-check cron / live
 * payment_attempts queries) prepare this and hand it to the router.
 */
export interface ProviderHealthSummary {
  providerId: string;
  /** Number of payment_attempts in the last 60 seconds. */
  recentAttempts: number;
  /** Failures (outcome != 'success') in the last 60 seconds. */
  recentFailures: number;
  /** Most recent row in provider_health_checks, if any. */
  lastCheck: {
    status: HealthState;
    checkedAt: Date;
  } | null;
  /** Rolling success rate over the last 7 days, in [0, 1]. */
  successRate7d: number;
  /** Rolling average latency in ms over the last 7 days. */
  avgLatencyMs7d: number;
  /** Latest synthetic/native fee estimate in USD (decimal string). */
  estimatedFeeUsd?: string;
  /** Latest latency estimate in ms. */
  estimatedLatencyMs?: number;
}

/** A scored entry in a routing decision. */
export interface ScoredCandidate {
  providerId: string;
  rank: number;
  /** Lower is better. */
  score: number;
  reason: string;
}

/** The full routing decision, persisted to `routing_decisions`. */
export interface RoutingDecision {
  candidates: ScoredCandidate[];
  /** Top candidate's providerId, or null if none qualified. */
  selected: string | null;
  policyUsed: MerchantPolicy;
  optimize: OptimizeStrategy;
  decidedAt: Date;
}

/** Per-attempt outcome captured by FallbackManager and written to ledger. */
export interface AttemptOutcome {
  attemptNumber: number;
  providerId: string;
  startedAt: Date;
  completedAt: Date;
  outcome: PaymentAttemptOutcome;
  errorCode?: ErrorCode;
  errorMessage?: string;
  latencyMs: number;
  txHash?: string;
}

/** Initial fields needed to create a payment row. */
export interface PaymentInitialFields {
  network: Caip2;
  asset: string;
  amount: string;
  recipient: string;
  resource?: string;
  requestBody: unknown;
}

/** Materialized payment row, used for /payments/:id responses + idempotent replays. */
export interface PaymentRecord {
  paymentId: string;
  apiKeyId: string;
  idempotencyKey?: string;
  status: PaymentStatus;
  network: Caip2;
  asset: string;
  amount: string;
  payer?: string;
  recipient: string;
  resource?: string;
  finalProviderId?: string;
  providerPaymentId?: string;
  txHash?: string;
  errorCode?: ErrorCode;
  errorMessage?: string;
  createdAt: Date;
  settledAt?: Date;
}

/**
 * Result of `PaymentLedger.createOrFetchPayment`. `isNew=true` means
 * the orchestrator should process the settle; `isNew=false` means we
 * hit an idempotency replay and should return the existing payment's
 * recorded response.
 */
export interface CreateOrFetchResult {
  payment: PaymentRecord;
  isNew: boolean;
  /** Held only when isNew=true; release after the settle pipeline finishes. */
  lockKey: string | null;
}

/**
 * Hooks the fallback manager needs from the ledger. Kept narrow so
 * tests can satisfy it with a fake.
 */
export interface FallbackLedgerHooks {
  startAttempt(paymentId: string, providerId: string, attemptNumber: number): Promise<void>;
  finishAttempt(paymentId: string, attemptNumber: number, outcome: AttemptOutcome): Promise<void>;
}

/** Discovered + asset-specific facts returned by the cron. */
export interface CapabilityRow {
  providerId: string;
  network: Caip2;
  asset: string;
  scheme: string;
  isStatic: boolean;
  isDiscovered: boolean;
  discoveredAt: Date | null;
  supersededAt: Date | null;
}

/** Type alias to keep test signatures honest. */
export type SettleRequestT = SettleRequest;
export type DiscoveredCapabilityT = DiscoveredCapability;
