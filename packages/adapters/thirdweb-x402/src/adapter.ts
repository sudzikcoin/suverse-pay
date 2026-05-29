import type {
  Caip2,
  DiscoveredCapability,
  GetStatusHints,
  HealthStatus,
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
import { ProviderError } from "@suverse-pay/core-types";
import { BaseAdapter, httpJson, type StaticCapability } from "@suverse-pay/provider-sdk";
import { mapThirdwebErrorReason, type ThirdwebLogger } from "./error-map.js";
import {
  ThirdwebSettleResponseSchema,
  ThirdwebSupportedResponseSchema,
  ThirdwebVerifyResponseSchema,
} from "./wire.js";

const ADAPTER_ID = "thirdweb-x402";
const DEFAULT_DISPLAY_NAME = "Thirdweb Nexus x402 Facilitator";

/**
 * Public Nexus facilitator surface.
 *
 * Thirdweb runs a second surface at `https://api.thirdweb.com/v1/payments/x402`
 * that uses `x-secret-key` auth (the unified Thirdweb client secret).
 * That surface requires auth on /supported too. We default to nexus-api
 * because /supported + /health are open there — discoverCapabilities()
 * and healthCheck() work without forcing operators to provide a key
 * just to register the adapter. Both base URL and auth header name are
 * overridable via config for operators who want the api.thirdweb.com
 * surface or use a custom proxy.
 */
const DEFAULT_BASE_URL = "https://nexus-api.thirdweb.com";
const DEFAULT_AUTH_HEADER = "x-nexus-key";
const DEFAULT_TIMEOUT_MS = 10_000;
const HEALTHCHECK_TIMEOUT_MS = 5_000;
const SCHEME = "exact";

export type ThirdwebWaitUntil = "simulated" | "submitted" | "confirmed";

export interface ThirdwebCapabilityConfig {
  /** CAIP-2 identifier, e.g. `eip155:10` for Optimism. */
  network: Caip2;
  /** Asset — ERC-20 contract address on EVM, SPL mint on Solana. */
  asset: string;
  /** Scheme — currently always `"exact"`. */
  scheme: string;
}

export interface ThirdwebAdapterConfig {
  /** Defaults to `https://nexus-api.thirdweb.com`. */
  baseUrl?: string;
  /** Static capabilities for this adapter instance. */
  capabilities: ReadonlyArray<ThirdwebCapabilityConfig>;
  /** USD-denominated fee estimate per settled payment. */
  estimatedFeeUsd: string;
  /**
   * API key for the Nexus surface. Sent as `x-nexus-key: <key>` by
   * default. Required for /verify and /settle; /supported and /health
   * work without it. Leave undefined for read-only discovery.
   */
  apiKey?: string;
  /**
   * Override the auth header name. Defaults to `x-nexus-key` (Nexus
   * surface). Use `x-secret-key` if pointing at the api.thirdweb.com
   * facilitator surface.
   */
  authHeaderName?: string;
  /**
   * Per-settle wait behaviour for the upstream facilitator. Forwarded
   * as `waitUntil` in /settle requests when set; omitted otherwise so
   * the upstream default (currently "confirmed") applies. Useful for
   * latency-sensitive smoke tests that don't need full confirmation.
   */
  waitUntil?: ThirdwebWaitUntil;
  displayName?: string;
  defaultTimeoutMs?: number;
  logger?: ThirdwebLogger;
  fetchImpl?: typeof globalThis.fetch;
}

export class ThirdwebX402Adapter extends BaseAdapter {
  readonly id = ADAPTER_ID;
  readonly displayName: string;

  private readonly baseUrl: string;
  private readonly capabilities: ReadonlyArray<ThirdwebCapabilityConfig>;
  private readonly estimatedFeeUsd: string;
  private readonly authHeaderName: string;
  private readonly apiKey: string | null;
  private readonly waitUntil: ThirdwebWaitUntil | undefined;
  private readonly timeoutMs: number;
  private readonly logger: ThirdwebLogger | undefined;
  private readonly fetchImpl: typeof globalThis.fetch | undefined;

  constructor(config: ThirdwebAdapterConfig) {
    const staticCapabilities: StaticCapability[] = config.capabilities.map(
      (cap) => ({ network: cap.network, asset: cap.asset, scheme: cap.scheme }),
    );
    super({
      staticCapabilities,
      defaultTimeoutMs: config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    this.displayName = config.displayName ?? DEFAULT_DISPLAY_NAME;
    this.baseUrl = trimTrailingSlash(config.baseUrl ?? DEFAULT_BASE_URL);
    this.capabilities = config.capabilities;
    this.estimatedFeeUsd = config.estimatedFeeUsd;
    this.authHeaderName = config.authHeaderName ?? DEFAULT_AUTH_HEADER;
    this.apiKey = config.apiKey !== undefined && config.apiKey.length > 0
      ? config.apiKey
      : null;
    if (config.waitUntil !== undefined) this.waitUntil = config.waitUntil;
    this.timeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (config.logger !== undefined) this.logger = config.logger;
    if (config.fetchImpl !== undefined) this.fetchImpl = config.fetchImpl;
  }

  override async supports(req: SupportQuery): Promise<SupportResult> {
    const matched = this.capabilities.some(
      (cap) =>
        cap.network === req.network &&
        cap.asset === req.asset &&
        cap.scheme === req.scheme,
    );
    return matched ? { supported: true } : { supported: false };
  }

  override async quote(req: QuoteRequest): Promise<QuoteResponse> {
    return {
      providerId: this.id,
      network: req.network,
      asset: req.asset,
      amount: req.amount,
      estimatedFeeUsd: this.estimatedFeeUsd,
      // Thirdweb's facilitator submits through their server wallet
      // (EIP-7702) so confirmation latency is dominated by the
      // underlying chain. EVM L2s are typically 2-4s; we pick a
      // mid-range value and the orchestrator refines from health-check
      // latency.
      estimatedLatencyMs: 3_000,
      scheme: req.scheme,
      source: "synthetic",
    };
  }

  override async verify(req: VerifyRequest): Promise<VerifyResponse> {
    const verifiedAtIso = new Date().toISOString();
    const httpOpts = {
      method: "POST" as const,
      body: toThirdwebRequest(req),
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
      providerId: this.id,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    };
    const { data } = await httpJson<unknown>(`${this.baseUrl}/verify`, httpOpts);
    const parsed = ThirdwebVerifyResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError(
        "provider_internal_error",
        `Thirdweb /verify returned a malformed body: ${parsed.error.message}`,
        { providerId: this.id },
      );
    }
    const v = parsed.data;
    if (v.isValid) {
      return {
        valid: true,
        providerId: this.id,
        ...(v.payer !== undefined ? { payer: v.payer } : {}),
        verifiedAt: verifiedAtIso,
      };
    }
    const errorCode = mapThirdwebErrorReason(v.invalidReason, {
      ...(this.logger !== undefined ? { logger: this.logger } : {}),
      context: {
        endpoint: "/verify",
        invalidReason: v.invalidReason,
        invalidMessage: v.invalidMessage,
        errorMessage: v.errorMessage,
      },
    });
    const errorMessage = v.invalidMessage ?? v.errorMessage ?? v.invalidReason;
    return {
      valid: false,
      providerId: this.id,
      ...(v.payer !== undefined ? { payer: v.payer } : {}),
      verifiedAt: verifiedAtIso,
      errorCode,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
  }

  /**
   * Settle a payment via Thirdweb's /settle. Internal retry is enabled
   * ONLY when the caller supplies an `idempotencyKey` — Thirdweb doesn't
   * document Idempotency-Key support today, but emitting the header is
   * harmless and a future server-side implementation that respects it
   * gets correct behaviour for free. Re-sending the same EIP-3009
   * authorization is safe at the protocol layer because the on-chain
   * `nonce_already_used` guard rejects duplicate broadcasts.
   */
  override async settle(
    req: SettleRequest,
    opts?: SettleOptions,
  ): Promise<SettleResponse> {
    const settledAtIso = new Date().toISOString();
    const networkFromReq = req.paymentRequirements.network;
    const amountFromReq = req.paymentRequirements.maxAmountRequired;
    const asset = req.paymentRequirements.asset;
    const httpOpts = {
      method: "POST" as const,
      body: toThirdwebRequest(req, this.waitUntil),
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
      providerId: this.id,
      ...(opts?.idempotencyKey !== undefined
        ? {
            idempotencyKey: opts.idempotencyKey,
            retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 2_000 },
          }
        : {}),
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    };
    const { data } = await httpJson<unknown>(`${this.baseUrl}/settle`, httpOpts);
    const parsed = ThirdwebSettleResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError(
        "provider_internal_error",
        `Thirdweb /settle returned a malformed body: ${parsed.error.message}`,
        { providerId: this.id },
      );
    }
    const s = parsed.data;
    if (s.success) {
      return {
        settled: true,
        providerId: this.id,
        ...(s.transaction !== undefined && s.transaction !== ""
          ? { txHash: s.transaction }
          : {}),
        network: networkFromReq,
        amount: s.amount ?? amountFromReq,
        asset,
        ...(s.payer !== undefined ? { payer: s.payer } : {}),
        settledAt: settledAtIso,
      };
    }
    const errorReason = s.errorReason ?? s.invalidReason;
    const errorCode = mapThirdwebErrorReason(errorReason, {
      ...(this.logger !== undefined ? { logger: this.logger } : {}),
      context: {
        endpoint: "/settle",
        errorReason,
        errorMessage: s.errorMessage,
      },
    });
    const errorMessage = s.errorMessage ?? errorReason;
    return {
      settled: false,
      providerId: this.id,
      network: networkFromReq,
      amount: s.amount ?? amountFromReq,
      asset,
      ...(s.payer !== undefined ? { payer: s.payer } : {}),
      errorCode,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
  }

  /**
   * Thirdweb exposes no documented payment-id-keyed status endpoint;
   * status is reconstructed from orchestrator-supplied hints, same as
   * cosmos-pay / coinbase-cdp / payai.
   */
  override async getStatus(
    providerPaymentId: string,
    hints?: GetStatusHints,
  ): Promise<StatusResponse> {
    if (hints?.txHash !== undefined && hints.txHash !== "") {
      return {
        providerId: this.id,
        providerPaymentId,
        status: "settled",
        txHash: hints.txHash,
      };
    }
    if (hints?.errorCode !== undefined) {
      return {
        providerId: this.id,
        providerPaymentId,
        status: "failed",
        errorCode: hints.errorCode,
      };
    }
    return {
      providerId: this.id,
      providerPaymentId,
      status: "pending",
    };
  }

  /**
   * Thirdweb exposes a documented `/health` endpoint that returns
   * `{status, timestamp, database}`. We use it for liveness — it's
   * cheaper than /supported and dedicated to the purpose.
   */
  override async healthCheck(): Promise<HealthStatus> {
    const fetchImpl = this.fetchImpl ?? globalThis.fetch;
    const startedAt = Date.now();
    const checkedAt = new Date(startedAt).toISOString();
    try {
      const response = await fetchImpl(`${this.baseUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MS),
      });
      const latencyMs = Date.now() - startedAt;
      if (response.ok) {
        return { status: "healthy", latencyMs, checkedAt };
      }
      return {
        status: "down",
        latencyMs,
        error: `HTTP ${response.status}`,
        checkedAt,
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      return {
        status: "down",
        latencyMs,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        checkedAt,
      };
    }
  }

  /**
   * GET /supported, cross-join with the statically-configured assets.
   *
   * Thirdweb's live /supported response embeds the on-chain asset
   * metadata (`extra.defaultAsset.address`) for each network, but we
   * still constrain to the static config — that's where operators
   * authorize specific (network, asset) pairs. Discovered entries not
   * present in the static config are skipped with a warning.
   *
   * `x402Version` filtering: PayAI advertises both v1 (short network
   * names) and v2 (CAIP-2) for the same kind, and we filter to v2.
   * Thirdweb currently advertises everything as v1 but uses CAIP-2
   * network ids regardless — so v1-filtering here would discard every
   * entry. We accept any version; the static config is authoritative.
   *
   * `Permit` (EIP-2612) entries are emitted but operators should not
   * add them to their static caps unless they have a signer that
   * produces EIP-2612 signatures. Our signer-evm is EIP-3009-only as
   * of v0.3.1; permit support is a separate sub-task.
   */
  override async discoverCapabilities(): Promise<DiscoveredCapability[]> {
    const httpOpts = {
      method: "GET" as const,
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
      providerId: this.id,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    };
    const { data } = await httpJson<unknown>(
      `${this.baseUrl}/supported`,
      httpOpts,
    );
    const parsed = ThirdwebSupportedResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError(
        "provider_internal_error",
        `Thirdweb /supported returned a malformed body: ${parsed.error.message}`,
        { providerId: this.id },
      );
    }
    const warn = this.logger?.warn.bind(this.logger) ?? defaultWarn;
    const out: DiscoveredCapability[] = [];
    for (const kind of parsed.data.kinds) {
      if (kind.scheme !== SCHEME) {
        // Future-proofing: Thirdweb might add `permit2-exact` etc.
        // Until our orchestrator and signer-evm understand them, the
        // adapter ignores non-exact schemes.
        continue;
      }
      const matches = this.capabilities.filter(
        (cap) => cap.network === kind.network && cap.scheme === kind.scheme,
      );
      if (matches.length === 0) {
        warn(
          `Thirdweb /supported lists (${kind.scheme}, ${kind.network}) but adapter has no asset configured; skipping`,
          { network: kind.network, scheme: kind.scheme },
        );
        continue;
      }
      for (const cap of matches) {
        out.push({
          network: cap.network,
          asset: cap.asset,
          scheme: cap.scheme,
        });
      }
    }
    return out;
  }

  private headers(): Record<string, string> | undefined {
    if (this.apiKey === null) return undefined;
    return { [this.authHeaderName]: this.apiKey };
  }
}

function toThirdwebRequest(
  req: VerifyRequest | SettleRequest,
  waitUntil?: ThirdwebWaitUntil,
): unknown {
  const payload = req.paymentPayload;
  const x402Version =
    typeof payload.x402Version === "number" ? payload.x402Version : 1;
  return {
    x402Version,
    paymentPayload: payload,
    paymentRequirements: req.paymentRequirements,
    ...(waitUntil !== undefined ? { waitUntil } : {}),
  };
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function defaultWarn(message: string, context?: Record<string, unknown>): void {
  if (context !== undefined) {
    console.warn(`[thirdweb-x402-adapter] ${message}`, context);
  } else {
    console.warn(`[thirdweb-x402-adapter] ${message}`);
  }
}
