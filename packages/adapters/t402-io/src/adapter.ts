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
import { mapT402ErrorReason, type T402Logger } from "./error-map.js";
import {
  T402SettleResponseSchema,
  T402SupportedResponseSchema,
  T402VerifyResponseSchema,
} from "./wire.js";

const ADAPTER_ID = "t402-io";
const DEFAULT_DISPLAY_NAME = "t402-io Universal USDT Facilitator";

/**
 * Public hosted t402-io facilitator. `/supported` and `/health` open;
 * `/verify` and `/settle` require X-API-Key. No public signup flow
 * discovered as of 2026-05-29 — adapter registers cleanly with or
 * without a key, but verify/settle throws `unauthorized` when the
 * key is missing.
 */
const DEFAULT_BASE_URL = "https://facilitator.t402.io";
const DEFAULT_TIMEOUT_MS = 10_000;
const HEALTHCHECK_TIMEOUT_MS = 5_000;

/**
 * Schemes t402-io advertises live (2026-05-29):
 *   - `exact` — canonical x402 EIP-3009 / equivalent on non-EVM chains
 *   - `exact-direct` — direct ERC-20 transfer (no signed authorization)
 *   - `exact-legacy` — backwards-compat path
 *   - `upto` — pay up to a maximum (similar to x402's upto scheme)
 *
 * The adapter forwards whichever scheme the orchestrator selects.
 */
export const T402_SCHEMES = [
  "exact",
  "exact-direct",
  "exact-legacy",
  "upto",
] as const;
export type T402Scheme = (typeof T402_SCHEMES)[number];

export interface T402CapabilityConfig {
  /**
   * CAIP-2 identifier. eip155:N for EVM chains, plus
   * non-EVM namespaces t402-io advertises: tron, solana, cosmos,
   * aptos, near, polkadot, stacks, stellar, tezos, ton.
   */
  network: Caip2;
  /** Asset — contract address on EVM, base58 on TRON, etc. */
  asset: string;
  /** One of T402_SCHEMES. */
  scheme: string;
}

export interface T402AdapterConfig {
  /** Defaults to `https://facilitator.t402.io`. */
  baseUrl?: string;
  /** Static capability entries the adapter advertises. */
  capabilities: ReadonlyArray<T402CapabilityConfig>;
  /** USD-denominated fee estimate per settled payment. */
  estimatedFeeUsd: string;
  /**
   * t402-io API key (sent as `X-API-Key` header on verify/settle).
   * Absent → verify/settle throws `unauthorized`. `/supported` and
   * `/health` work without it.
   */
  apiKey?: string;
  displayName?: string;
  defaultTimeoutMs?: number;
  logger?: T402Logger;
  fetchImpl?: typeof globalThis.fetch;
}

export class T402IoAdapter extends BaseAdapter {
  readonly id = ADAPTER_ID;
  readonly displayName: string;

  private readonly baseUrl: string;
  private readonly capabilities: ReadonlyArray<T402CapabilityConfig>;
  private readonly estimatedFeeUsd: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;
  private readonly logger: T402Logger | undefined;
  private readonly fetchImpl: typeof globalThis.fetch | undefined;

  constructor(config: T402AdapterConfig) {
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
    this.apiKey =
      config.apiKey !== undefined && config.apiKey.length > 0
        ? config.apiKey
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
      // t402-io routes through chain-specific mechanisms; latency
      // varies wildly (EVM ~3s, Solana ~600ms, TON ~5-15s, Stellar
      // ~5s). Midline value, refined by orchestrator from observed
      // health-check latency.
      estimatedLatencyMs: 4_500,
      scheme: req.scheme,
      source: "synthetic",
    };
  }

  override async verify(req: VerifyRequest): Promise<VerifyResponse> {
    this.requireApiKey("/verify");
    const verifiedAtIso = new Date().toISOString();
    const httpOpts = {
      method: "POST" as const,
      body: toT402Request(req),
      headers: this.authHeaders(),
      timeoutMs: this.timeoutMs,
      providerId: this.id,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    };
    const { data } = await httpJson<unknown>(`${this.baseUrl}/verify`, httpOpts);
    const parsed = T402VerifyResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError(
        "provider_internal_error",
        `t402-io /verify returned a malformed body: ${parsed.error.message}`,
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
    const errorCode = mapT402ErrorReason(v.invalidReason, {
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
    this.requireApiKey("/settle");
    const settledAtIso = new Date().toISOString();
    const networkFromReq = req.paymentRequirements.network;
    const amountFromReq = req.paymentRequirements.maxAmountRequired;
    const asset = req.paymentRequirements.asset;
    const httpOpts = {
      method: "POST" as const,
      body: toT402Request(req),
      headers: this.authHeaders(),
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
    const parsed = T402SettleResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError(
        "provider_internal_error",
        `t402-io /settle returned a malformed body: ${parsed.error.message}`,
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
    const errorCode = mapT402ErrorReason(errorReason, {
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
   * `/health` returns `{"status":"healthy","version":"<string>"}`.
   * Open endpoint, no auth required.
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
   * GET /supported. Open endpoint (no auth required), so discovery
   * works without API key. Cross-joins discovered (network, scheme)
   * pairs with the static config. Entries the adapter wasn't
   * configured for are skipped with a warning.
   *
   * t402-io's response uses `t402Version` instead of `x402Version` —
   * the wire schema accepts that. The DiscoveredCapability shape we
   * return doesn't carry a version, so the rename is invisible
   * upstream.
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
    const parsed = T402SupportedResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError(
        "provider_internal_error",
        `t402-io /supported returned a malformed body: ${parsed.error.message}`,
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
          `t402-io /supported lists (${kind.scheme}, ${kind.network}) but adapter has no asset configured; skipping`,
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

  private authHeaders(): Record<string, string> | undefined {
    if (this.apiKey === null) return undefined;
    return { "X-API-Key": this.apiKey };
  }

  private requireApiKey(endpoint: string): void {
    if (this.apiKey === null) {
      throw new ProviderError(
        "unauthorized",
        `t402-io ${endpoint} requires an API key (set T402_IO_API_KEY). No public signup flow discovered as of 2026-05-29 — see packages/adapters/t402-io/README.md.`,
        { providerId: this.id },
      );
    }
  }
}

/**
 * Translate a suverse-pay `VerifyRequest`/`SettleRequest` into t402's
 * wire body.
 *
 * t402's body differs from x402 v2's:
 *   - top-level key is `t402Version` instead of `x402Version`
 *   - `paymentRequirements` is renamed `accepted` AND nested inside
 *     `paymentPayload` (t402 spec §4)
 *   - `paymentPayload` itself stays top-level and carries `resource`
 *     metadata that x402 doesn't require
 *
 * We construct the minimum valid t402 body and forward; t402-io's
 * facilitator accepts the canonical `{paymentPayload, paymentRequirements}`
 * shape too as a compat path (per their examples/typescript/facilitator
 * README which shows both shapes), so we send the canonical shape with
 * t402Version added — simpler, fewer edge cases, less likely to break
 * on protocol churn.
 */
function toT402Request(req: VerifyRequest | SettleRequest): unknown {
  const payload = req.paymentPayload;
  const version =
    typeof payload.x402Version === "number" ? payload.x402Version : 2;
  return {
    // Both names emitted — t402-io accepts whichever it prefers; the
    // canonical x402 facilitator code paths inside t402-io's monorepo
    // look at `x402Version` for compat, and the v2 spec looks at
    // `t402Version`. Belt + suspenders.
    t402Version: version,
    x402Version: version,
    paymentPayload: payload,
    paymentRequirements: req.paymentRequirements,
  };
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function defaultWarn(message: string, context?: Record<string, unknown>): void {
  if (context !== undefined) {
    console.warn(`[t402-io-adapter] ${message}`, context);
  } else {
    console.warn(`[t402-io-adapter] ${message}`);
  }
}
