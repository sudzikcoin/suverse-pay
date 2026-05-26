import type {
  Caip2,
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
  SupportResult,
  VerifyRequest,
  VerifyResponse,
} from "@suverse-pay/core-types";

export interface StaticCapability {
  network: Caip2;
  asset: string;
  scheme: string;
}

export interface BaseAdapterConfig {
  staticCapabilities: ReadonlyArray<StaticCapability>;
  defaultTimeoutMs?: number;
  defaultRetry?: {
    maxAttempts: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
}

export abstract class BaseAdapter implements ProviderAdapter {
  abstract readonly id: string;
  abstract readonly displayName: string;

  protected readonly config: BaseAdapterConfig;

  constructor(config: BaseAdapterConfig) {
    this.config = config;
  }

  /**
   * Default `supports()` implementation, derived from static capabilities.
   * Adapters with quota/throttle logic (e.g. coinbase-cdp's monthly cap)
   * MUST override this to fold in runtime state.
   */
  async supports(req: SupportQuery): Promise<SupportResult> {
    const matched = this.config.staticCapabilities.some(
      (cap) =>
        cap.network === req.network &&
        cap.asset === req.asset &&
        cap.scheme === req.scheme,
    );
    return { supported: matched };
  }

  abstract quote(req: QuoteRequest): Promise<QuoteResponse>;

  abstract verify(req: VerifyRequest): Promise<VerifyResponse>;

  /**
   * Settles a payment. Implementations that enable internal retry MUST
   * propagate `opts.idempotencyKey` to the downstream provider so that
   * a duplicate provider call (caused by retry across a transient 5xx)
   * does not double-settle on-chain. See suverse-pay CLAUDE.md
   * §"Critical invariants — Idempotency".
   */
  abstract settle(req: SettleRequest, opts?: SettleOptions): Promise<SettleResponse>;

  abstract getStatus(
    providerPaymentId: string,
    hints?: GetStatusHints,
  ): Promise<StatusResponse>;

  abstract healthCheck(): Promise<HealthStatus>;

  discoverCapabilities?(): Promise<DiscoveredCapability[]>;

  protected staticCapabilitiesAsDiscovered(): DiscoveredCapability[] {
    return this.config.staticCapabilities.map((cap) => ({
      network: cap.network,
      asset: cap.asset,
      scheme: cap.scheme,
    }));
  }
}
