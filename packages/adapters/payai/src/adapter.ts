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
import { mapPayAiErrorReason, type PayAiLogger } from "./error-map.js";
import {
  PayAiSettleResponseSchema,
  PayAiSupportedResponseSchema,
  PayAiVerifyResponseSchema,
} from "./wire.js";

const ADAPTER_ID = "payai";
const DEFAULT_DISPLAY_NAME = "PayAI Facilitator";
const DEFAULT_BASE_URL = "https://facilitator.payai.network";
const DEFAULT_TIMEOUT_MS = 10_000;
const HEALTHCHECK_TIMEOUT_MS = 5_000;
const X402_VERSION = 2;
const SCHEME = "exact";

export interface PayAiCapabilityConfig {
  /** CAIP-2 identifier, e.g. `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. */
  network: Caip2;
  /** Asset — SPL token mint on Solana, ERC-20 address on EVM. */
  asset: string;
  /** Scheme — currently always `"exact"`; PayAI uses the canonical name. */
  scheme: string;
}

export interface PayAiAdapterConfig {
  /** Defaults to `https://facilitator.payai.network`. */
  baseUrl?: string;
  /** Static capabilities for this adapter instance. */
  capabilities: ReadonlyArray<PayAiCapabilityConfig>;
  /** USD-denominated fee estimate per settled payment. */
  estimatedFeeUsd: string;
  /**
   * Optional API key id for the paid tier (raises rate limits above
   * the 10 000 settlements/month free-tier cap). Free tier requires
   * no auth — leave both fields undefined for that.
   */
  apiKeyId?: string;
  /** Optional API key secret paired with `apiKeyId`. */
  apiKeySecret?: string;
  displayName?: string;
  defaultTimeoutMs?: number;
  logger?: PayAiLogger;
  fetchImpl?: typeof globalThis.fetch;
}

export class PayAiAdapter extends BaseAdapter {
  readonly id = ADAPTER_ID;
  readonly displayName: string;

  private readonly baseUrl: string;
  private readonly capabilities: ReadonlyArray<PayAiCapabilityConfig>;
  private readonly estimatedFeeUsd: string;
  private readonly authHeader: string | null;
  private readonly timeoutMs: number;
  private readonly logger: PayAiLogger | undefined;
  private readonly fetchImpl: typeof globalThis.fetch | undefined;

  constructor(config: PayAiAdapterConfig) {
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

    // Paid tier auth header. PayAI's documented form is Basic auth
    // with key id + secret, so the adapter assembles the header at
    // construction time and re-sends it on every request. Free tier
    // skips the header entirely.
    if (
      config.apiKeyId !== undefined &&
      config.apiKeyId.length > 0 &&
      config.apiKeySecret !== undefined &&
      config.apiKeySecret.length > 0
    ) {
      const credentials = `${config.apiKeyId}:${config.apiKeySecret}`;
      const encoded = Buffer.from(credentials, "utf8").toString("base64");
      this.authHeader = `Basic ${encoded}`;
    } else {
      this.authHeader = null;
    }
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
      // Solana confirmation on mainnet is consistently sub-second; we
      // pick a midline value, the orchestrator refines it from
      // observed health-check latency.
      estimatedLatencyMs: 600,
      scheme: req.scheme,
      source: "synthetic",
    };
  }

  override async verify(req: VerifyRequest): Promise<VerifyResponse> {
    const verifiedAtIso = new Date().toISOString();
    const httpOpts = {
      method: "POST" as const,
      body: toPayAiRequest(req),
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
      providerId: this.id,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    };
    const { data } = await httpJson<unknown>(`${this.baseUrl}/verify`, httpOpts);
    const parsed = PayAiVerifyResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError(
        "provider_internal_error",
        `PayAI /verify returned a malformed body: ${parsed.error.message}`,
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
    const errorCode = mapPayAiErrorReason(v.invalidReason, {
      ...(this.logger !== undefined ? { logger: this.logger } : {}),
      context: {
        endpoint: "/verify",
        invalidReason: v.invalidReason,
        invalidMessage: v.invalidMessage,
      },
    });
    const errorMessage = v.invalidMessage ?? v.invalidReason;
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
   * Settle a payment via PayAI's /settle. As with cosmos-pay, internal
   * retry is enabled ONLY when the caller supplies an
   * `idempotencyKey` — PayAI does not document idempotency-key
   * support, but the SVM exact spec mandates an in-memory dedup cache
   * facilitator-side (see scheme_exact_svm.md "Duplicate Settlement
   * Mitigation"). Re-sending the same base64 transaction within
   * ~120s of the first attempt is therefore safe at the protocol
   * layer; we still pass `Idempotency-Key` so a future PayAI server
   * implementation that respects the header gets the right behaviour.
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
      body: toPayAiRequest(req),
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
    const parsed = PayAiSettleResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError(
        "provider_internal_error",
        `PayAI /settle returned a malformed body: ${parsed.error.message}`,
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
    const errorCode = mapPayAiErrorReason(s.errorReason, {
      ...(this.logger !== undefined ? { logger: this.logger } : {}),
      context: {
        endpoint: "/settle",
        errorReason: s.errorReason,
        errorMessage: s.errorMessage,
      },
    });
    const errorMessage = s.errorMessage ?? s.errorReason;
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
   * PayAI does not expose a status endpoint. Status is reconstructed
   * from orchestrator-supplied hints, like cosmos-pay + coinbase-cdp.
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
   * PayAI exposes no documented /health endpoint; we hit /supported
   * with a short timeout — it's a small read that doubles as a
   * liveness probe.
   */
  override async healthCheck(): Promise<HealthStatus> {
    const fetchImpl = this.fetchImpl ?? globalThis.fetch;
    const startedAt = Date.now();
    const checkedAt = new Date(startedAt).toISOString();
    try {
      const response = await fetchImpl(`${this.baseUrl}/supported`, {
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
   * PayAI's live /supported response includes BOTH x402 v1 entries
   * (legacy short network names — e.g. `network: "solana"`) AND v2
   * entries (CAIP-2 — e.g. `network: "solana:5eykt4..."`). The adapter
   * ignores v1 entries (the suverse-pay gateway is v2-only) to avoid
   * advertising the same capability twice under two identifiers.
   *
   * Discovered (scheme, network) pairs not present in the static
   * config are skipped with a warning — we can't safely transact
   * without knowing the asset, and PayAI's /supported doesn't echo
   * asset info.
   */
  override async discoverCapabilities(): Promise<DiscoveredCapability[]> {
    const httpOpts = {
      method: "GET" as const,
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
      providerId: this.id,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    };
    const { data } = await httpJson<unknown>(`${this.baseUrl}/supported`, httpOpts);
    const parsed = PayAiSupportedResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError(
        "provider_internal_error",
        `PayAI /supported returned a malformed body: ${parsed.error.message}`,
        { providerId: this.id },
      );
    }
    const warn = this.logger?.warn.bind(this.logger) ?? defaultWarn;
    const out: DiscoveredCapability[] = [];
    for (const kind of parsed.data.kinds) {
      if (kind.x402Version !== X402_VERSION) {
        // Ignore legacy v1 entries; they duplicate the v2 ones.
        continue;
      }
      const matches = this.capabilities.filter(
        (cap) => cap.network === kind.network && cap.scheme === kind.scheme,
      );
      if (matches.length === 0) {
        warn(
          `PayAI /supported lists (${kind.scheme}, ${kind.network}) but adapter has no asset configured; skipping`,
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
    return this.authHeader !== null ? { Authorization: this.authHeader } : undefined;
  }
}

function toPayAiRequest(req: VerifyRequest | SettleRequest): unknown {
  const payload = req.paymentPayload;
  const x402Version =
    typeof payload.x402Version === "number" ? payload.x402Version : X402_VERSION;
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
    console.warn(`[payai-adapter] ${message}`, context);
  } else {
    console.warn(`[payai-adapter] ${message}`);
  }
}
