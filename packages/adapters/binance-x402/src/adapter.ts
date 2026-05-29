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
import {
  BaseAdapter,
  httpJson,
  type StaticCapability,
} from "@suverse-pay/provider-sdk";
import { buildBinanceAuthHeaders } from "./auth.js";
import { mapBinanceErrorReason, type BinanceLogger } from "./error-map.js";
import {
  BinanceSettleResponseSchema,
  BinanceSupportedResponseSchema,
  BinanceVerifyResponseSchema,
} from "./wire.js";

const ADAPTER_ID = "binance-x402";
const DEFAULT_DISPLAY_NAME = "Binance x402 Facilitator (BNB Chain)";

/**
 * Default base URL — the canonical Binance Pay merchant endpoint.
 * As of 2026-05-29 Binance has not published a dedicated x402 host;
 * the path prefix below is a best-guess matching Binance Pay's
 * conventions (`/binancepay/openapi/v1/...`). Both base URL and path
 * prefix are overridable via config so operators with merchant
 * onboarding can point at the exact path Binance reveals.
 */
const DEFAULT_BASE_URL = "https://bpay.binanceapi.com";
const DEFAULT_PATH_PREFIX = "/binancepay/openapi/v1/x402";
const DEFAULT_TIMEOUT_MS = 10_000;
const HEALTHCHECK_TIMEOUT_MS = 5_000;
const SCHEME = "exact";

export type BinanceAssetTransferMethod = "eip3009" | "permit2-exact" | "permit2-upto";

export interface BinanceCapabilityConfig {
  /** CAIP-2 — currently `eip155:56` (BNB Chain mainnet) and `eip155:97` (BSC Testnet). */
  network: Caip2;
  /**
   * ERC-20 contract address. BNB Chain stablecoins are 18-decimal —
   * the orchestrator uses the signer-evm `usdt-tokens.ts` table to
   * format amounts; this adapter only carries the address.
   */
  asset: string;
  /** Always `"exact"` for Binance x402. */
  scheme: string;
  /**
   * Which authorization method Binance accepts for this (network,
   * asset) pair. Binance announced `eip3009`, `permit2-exact`,
   * `permit2-upto` at launch. Informational; the orchestrator picks
   * the method based on token capabilities, not this field.
   */
  assetTransferMethod?: BinanceAssetTransferMethod;
}

export interface BinanceAdapterConfig {
  /** Defaults to `https://bpay.binanceapi.com`. */
  baseUrl?: string;
  /**
   * Path prefix appended to baseUrl before `/verify` / `/settle` /
   * `/supported`. Defaults to the Binance Pay convention; once
   * Binance publishes the exact x402 mount point this becomes a
   * one-line config change.
   */
  pathPrefix?: string;
  /** Static capability entries the adapter advertises. */
  capabilities: ReadonlyArray<BinanceCapabilityConfig>;
  /** USD-denominated fee estimate per settled payment. */
  estimatedFeeUsd: string;
  /** Binance Pay merchant API key id (BinancePay-Certificate-SN). */
  apiKeyId?: string;
  /** Binance Pay merchant API secret (HMAC-SHA512 key). */
  apiSecret?: string;
  displayName?: string;
  defaultTimeoutMs?: number;
  logger?: BinanceLogger;
  fetchImpl?: typeof globalThis.fetch;
}

export class BinanceX402Adapter extends BaseAdapter {
  readonly id = ADAPTER_ID;
  readonly displayName: string;

  private readonly baseUrl: string;
  private readonly pathPrefix: string;
  private readonly capabilities: ReadonlyArray<BinanceCapabilityConfig>;
  private readonly estimatedFeeUsd: string;
  private readonly apiKeyId: string | null;
  private readonly apiSecret: string | null;
  private readonly timeoutMs: number;
  private readonly logger: BinanceLogger | undefined;
  private readonly fetchImpl: typeof globalThis.fetch | undefined;

  constructor(config: BinanceAdapterConfig) {
    const staticCapabilities: StaticCapability[] = config.capabilities.map(
      (cap) => ({ network: cap.network, asset: cap.asset, scheme: cap.scheme }),
    );
    super({
      staticCapabilities,
      defaultTimeoutMs: config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    this.displayName = config.displayName ?? DEFAULT_DISPLAY_NAME;
    this.baseUrl = trimTrailingSlash(config.baseUrl ?? DEFAULT_BASE_URL);
    this.pathPrefix = normalizePathPrefix(config.pathPrefix ?? DEFAULT_PATH_PREFIX);
    this.capabilities = config.capabilities;
    this.estimatedFeeUsd = config.estimatedFeeUsd;
    this.apiKeyId =
      config.apiKeyId !== undefined && config.apiKeyId.length > 0
        ? config.apiKeyId
        : null;
    this.apiSecret =
      config.apiSecret !== undefined && config.apiSecret.length > 0
        ? config.apiSecret
        : null;
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
      // BNB Chain blocks finalize in ~3s; settle latency for Binance's
      // facilitator is dominated by their internal queue + the chain.
      // Midline value, refined by orchestrator from observed health
      // latency.
      estimatedLatencyMs: 4_000,
      scheme: req.scheme,
      source: "synthetic",
    };
  }

  override async verify(req: VerifyRequest): Promise<VerifyResponse> {
    this.requireCredentials("/verify");
    const verifiedAtIso = new Date().toISOString();
    const body = toBinanceRequest(req);
    const bodyJson = JSON.stringify(body);
    const httpOpts = {
      method: "POST" as const,
      body,
      headers: this.signedHeaders(bodyJson),
      timeoutMs: this.timeoutMs,
      providerId: this.id,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    };
    const { data } = await httpJson<unknown>(this.url("/verify"), httpOpts);
    const parsed = BinanceVerifyResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError(
        "provider_internal_error",
        `Binance x402 /verify returned a malformed body: ${parsed.error.message}`,
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
    const errorCode = mapBinanceErrorReason(v.invalidReason, {
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
    this.requireCredentials("/settle");
    const settledAtIso = new Date().toISOString();
    const networkFromReq = req.paymentRequirements.network;
    const amountFromReq = req.paymentRequirements.maxAmountRequired;
    const asset = req.paymentRequirements.asset;
    const body = toBinanceRequest(req);
    const bodyJson = JSON.stringify(body);
    const httpOpts = {
      method: "POST" as const,
      body,
      headers: this.signedHeaders(bodyJson),
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
    const { data } = await httpJson<unknown>(this.url("/settle"), httpOpts);
    const parsed = BinanceSettleResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError(
        "provider_internal_error",
        `Binance x402 /settle returned a malformed body: ${parsed.error.message}`,
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
    const errorCode = mapBinanceErrorReason(errorReason, {
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
   * Health probe hits `/supported`. If credentials are absent we
   * still attempt the call — Binance may surface a 401, which we
   * report as down rather than healthy, but the gateway will keep
   * the adapter registered so an operator who later supplies keys
   * sees it auto-recover.
   */
  override async healthCheck(): Promise<HealthStatus> {
    const fetchImpl = this.fetchImpl ?? globalThis.fetch;
    const startedAt = Date.now();
    const checkedAt = new Date(startedAt).toISOString();
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (this.apiKeyId !== null && this.apiSecret !== null) {
        // GET payload signing per Binance convention: body is "".
        const auth = buildBinanceAuthHeaders({
          apiKeyId: this.apiKeyId,
          apiSecret: this.apiSecret,
          bodyJson: "",
        });
        Object.assign(headers, auth);
      }
      const response = await fetchImpl(this.url("/supported"), {
        method: "GET",
        headers,
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
   * Discovery — pulls /supported, cross-joins with static caps. Same
   * pattern as Thirdweb. Requires creds because Binance gates the
   * merchant API; absent credentials we surface a clear error instead
   * of returning an empty list (which would look like a healthy
   * "Binance has nothing to offer" response).
   */
  override async discoverCapabilities(): Promise<DiscoveredCapability[]> {
    if (this.apiKeyId === null || this.apiSecret === null) {
      throw new ProviderError(
        "unauthorized",
        "Binance x402 /supported requires merchant credentials (BinancePay-Certificate-SN); set BINANCE_X402_API_KEY + BINANCE_X402_API_SECRET to enable discovery",
        { providerId: this.id },
      );
    }
    const auth = buildBinanceAuthHeaders({
      apiKeyId: this.apiKeyId,
      apiSecret: this.apiSecret,
      bodyJson: "",
    });
    const httpOpts = {
      method: "GET" as const,
      headers: auth,
      timeoutMs: this.timeoutMs,
      providerId: this.id,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    };
    const { data } = await httpJson<unknown>(this.url("/supported"), httpOpts);
    const parsed = BinanceSupportedResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError(
        "provider_internal_error",
        `Binance x402 /supported returned a malformed body: ${parsed.error.message}`,
        { providerId: this.id },
      );
    }
    const warn = this.logger?.warn.bind(this.logger) ?? defaultWarn;
    const out: DiscoveredCapability[] = [];
    for (const kind of parsed.data.kinds) {
      if (kind.scheme !== SCHEME) continue;
      const matches = this.capabilities.filter(
        (cap) => cap.network === kind.network && cap.scheme === kind.scheme,
      );
      if (matches.length === 0) {
        warn(
          `Binance x402 /supported lists (${kind.scheme}, ${kind.network}) but adapter has no asset configured; skipping`,
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

  private url(path: string): string {
    return `${this.baseUrl}${this.pathPrefix}${path}`;
  }

  private signedHeaders(bodyJson: string): Record<string, string> {
    if (this.apiKeyId === null || this.apiSecret === null) {
      // Should never reach here — requireCredentials gates first.
      throw new ProviderError(
        "unauthorized",
        "Binance x402 adapter missing apiKeyId / apiSecret",
        { providerId: this.id },
      );
    }
    return buildBinanceAuthHeaders({
      apiKeyId: this.apiKeyId,
      apiSecret: this.apiSecret,
      bodyJson,
    });
  }

  private requireCredentials(endpoint: string): void {
    if (this.apiKeyId === null || this.apiSecret === null) {
      throw new ProviderError(
        "unauthorized",
        `Binance x402 ${endpoint} requires merchant credentials (BinancePay-Certificate-SN + secret); set BINANCE_X402_API_KEY + BINANCE_X402_API_SECRET`,
        { providerId: this.id },
      );
    }
  }
}

function toBinanceRequest(req: VerifyRequest | SettleRequest): unknown {
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

function normalizePathPrefix(prefix: string): string {
  let p = prefix;
  if (!p.startsWith("/")) p = "/" + p;
  if (p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function defaultWarn(message: string, context?: Record<string, unknown>): void {
  if (context !== undefined) {
    console.warn(`[binance-x402-adapter] ${message}`, context);
  } else {
    console.warn(`[binance-x402-adapter] ${message}`);
  }
}
