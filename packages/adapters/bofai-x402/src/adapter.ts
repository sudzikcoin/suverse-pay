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
import { mapBofaiErrorReason, type BofaiLogger } from "./error-map.js";
import {
  BofaiSettleResponseSchema,
  BofaiSupportedResponseSchema,
  BofaiVerifyResponseSchema,
} from "./wire.js";

const ADAPTER_ID = "bofai-x402";
const DEFAULT_DISPLAY_NAME = "BofAI x402 Facilitator (TRON + BSC)";

/**
 * Public BofAI facilitator. Open access — no API key required as of
 * v0.6.0 (per BofAI CHANGELOG: GasFree endpoints route through the
 * BankOfAI proxy and clients no longer need TronGrid API keys).
 */
const DEFAULT_BASE_URL = "https://facilitator.bankofai.io";
const DEFAULT_TIMEOUT_MS = 10_000;
const HEALTHCHECK_TIMEOUT_MS = 5_000;

/**
 * Schemes BofAI's facilitator advertises. `exact` is ERC-3009 (works
 * with our existing signer-evm on BSC); `exact_permit` uses a separate
 * PaymentPermit EIP-712/TIP-712 domain (signer support deferred);
 * `exact_gasfree` is TRON-only and uses a GasFreeController TIP-712
 * domain (signer support deferred). Adapter advertises all three —
 * client-side signing for the deferred ones is the caller's
 * responsibility.
 */
export const BOFAI_SCHEMES = ["exact", "exact_permit", "exact_gasfree"] as const;
export type BofaiScheme = (typeof BOFAI_SCHEMES)[number];

export interface BofaiCapabilityConfig {
  /** CAIP-2 — `eip155:56`, `eip155:97`, `tron:mainnet`, `tron:nile`, `tron:shasta`. */
  network: Caip2;
  /**
   * Asset — ERC-20 hex address on EVM, TRC-20 base58 address (T...)
   * on TRON.
   */
  asset: string;
  /** One of BOFAI_SCHEMES. Three-way scheme set per (network, asset). */
  scheme: string;
}

export interface BofaiAdapterConfig {
  /** Defaults to `https://facilitator.bankofai.io`. */
  baseUrl?: string;
  /** Static capability entries the adapter advertises. */
  capabilities: ReadonlyArray<BofaiCapabilityConfig>;
  /** USD-denominated fee estimate per settled payment. */
  estimatedFeeUsd: string;
  displayName?: string;
  defaultTimeoutMs?: number;
  logger?: BofaiLogger;
  fetchImpl?: typeof globalThis.fetch;
}

export class BofaiX402Adapter extends BaseAdapter {
  readonly id = ADAPTER_ID;
  readonly displayName: string;

  private readonly baseUrl: string;
  private readonly capabilities: ReadonlyArray<BofaiCapabilityConfig>;
  private readonly estimatedFeeUsd: string;
  private readonly timeoutMs: number;
  private readonly logger: BofaiLogger | undefined;
  private readonly fetchImpl: typeof globalThis.fetch | undefined;

  constructor(config: BofaiAdapterConfig) {
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
      // TRON blocks confirm in ~3s; BSC in ~3s as well. Midline.
      estimatedLatencyMs: 3_500,
      scheme: req.scheme,
      source: "synthetic",
    };
  }

  override async verify(req: VerifyRequest): Promise<VerifyResponse> {
    const verifiedAtIso = new Date().toISOString();
    const httpOpts = {
      method: "POST" as const,
      body: toBofaiRequest(req),
      timeoutMs: this.timeoutMs,
      providerId: this.id,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    };
    const { data } = await httpJson<unknown>(`${this.baseUrl}/verify`, httpOpts);
    const parsed = BofaiVerifyResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError(
        "provider_internal_error",
        `BofAI x402 /verify returned a malformed body: ${parsed.error.message}`,
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
    const errorCode = mapBofaiErrorReason(v.invalidReason, {
      ...(this.logger !== undefined ? { logger: this.logger } : {}),
      context: {
        endpoint: "/verify",
        invalidReason: v.invalidReason,
        invalidMessage: v.invalidMessage,
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
      body: toBofaiRequest(req),
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
    const parsed = BofaiSettleResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError(
        "provider_internal_error",
        `BofAI x402 /settle returned a malformed body: ${parsed.error.message}`,
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
    const errorCode = mapBofaiErrorReason(errorReason, {
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
   * BofAI exposes a dedicated `/health` endpoint that returns
   * `{"status":"ok"}`. Cheap, dedicated, no auth.
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
   * GET /supported — open, no auth. Cross-joins discovered (network,
   * scheme) pairs with the static config. Entries the adapter wasn't
   * configured for (e.g. an unknown TRON asset on tron:shasta) are
   * skipped with a warning.
   */
  override async discoverCapabilities(): Promise<DiscoveredCapability[]> {
    const httpOpts = {
      method: "GET" as const,
      timeoutMs: this.timeoutMs,
      providerId: this.id,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    };
    const { data } = await httpJson<unknown>(
      `${this.baseUrl}/supported`,
      httpOpts,
    );
    const parsed = BofaiSupportedResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError(
        "provider_internal_error",
        `BofAI x402 /supported returned a malformed body: ${parsed.error.message}`,
        { providerId: this.id },
      );
    }
    const warn = this.logger?.warn.bind(this.logger) ?? defaultWarn;
    const out: DiscoveredCapability[] = [];
    for (const kind of parsed.data.kinds) {
      const matches = this.capabilities.filter(
        (cap) => cap.network === kind.network && cap.scheme === kind.scheme,
      );
      if (matches.length === 0) {
        warn(
          `BofAI /supported lists (${kind.scheme}, ${kind.network}) but adapter has no asset configured; skipping`,
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
}

function toBofaiRequest(req: VerifyRequest | SettleRequest): unknown {
  const payload = req.paymentPayload;
  const x402Version =
    typeof payload.x402Version === "number" ? payload.x402Version : 2;
  return {
    x402Version,
    paymentPayload: payload,
    paymentRequirements: req.paymentRequirements,
  };
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function defaultWarn(message: string, context?: Record<string, unknown>): void {
  if (context !== undefined) {
    console.warn(`[bofai-x402-adapter] ${message}`, context);
  } else {
    console.warn(`[bofai-x402-adapter] ${message}`);
  }
}
