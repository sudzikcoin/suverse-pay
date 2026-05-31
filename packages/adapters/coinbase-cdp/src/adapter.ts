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
import { mapCdpErrorReason, type CdpLogger } from "./error-map.js";
import { createCdpJwtSigner, type CdpJwtSigner } from "./jwt-signer.js";
import { InMemoryUsageTracker, type UsageTracker } from "./usage-tracker.js";
import {
  CdpSettleResponseSchema,
  CdpSupportedResponseSchema,
  CdpVerifyResponseSchema,
} from "./wire.js";

const ADAPTER_ID = "coinbase-cdp";
const DEFAULT_DISPLAY_NAME = "Coinbase CDP";
const DEFAULT_TIMEOUT_MS = 10_000;
const HEALTHCHECK_TIMEOUT_MS = 5_000;
const DEFAULT_BASE_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const DEFAULT_MONTHLY_HARD_CAP = 5_000;

/**
 * CDP's hosted facilitator requires the EIP-712 USDC `{name, version}`
 * tuple to be set on `paymentRequirements.extra` for every EVM verify
 * — without it CDP returns 400 `missing EIP-712 domain name/version in
 * requirements.extra` and the seller's settle path dead-ends.
 *
 * CDP's own `/supported` response sometimes omits the per-kind `extra`
 * for these networks. When that happens the adapter's discovery would
 * persist `extras_json = NULL`, which propagates all the way through
 * `/facilitator/supported` to the seller's middleware and the buyer's
 * 402 challenge, and the next paid request fails verify. This map is
 * the adapter-side fallback: keyed by `${caip2}|${assetLowercase}` for
 * Circle (native + bridged) USDC, value is the on-chain DOMAIN
 * separator the seller needs to declare.
 *
 * Values cross-checked against `packages/x402-client/src/network/chains.ts`
 * — that file is the buyer-side source of truth and the buyer signs
 * against these exact strings. Drift between the two would silently
 * invalidate signatures, so add new chains in both files.
 */
const EVM_USDC_EIP712_DOMAINS: Readonly<Record<string, { name: string; version: string }>> = {
  // Base mainnet — Circle native USDC
  "eip155:8453|0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { name: "USD Coin", version: "2" },
  // Polygon mainnet — Circle native USDC
  "eip155:137|0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": { name: "USD Coin", version: "2" },
  // Arbitrum One mainnet — Circle native USDC
  "eip155:42161|0xaf88d065e77c8cc2239327c5edb3a432268e5831": { name: "USD Coin", version: "2" },
  // Arbitrum Sepolia — Circle test USDC
  "eip155:421614|0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d": { name: "USD Coin", version: "2" },
  // Base Sepolia — Circle test USDC (different on-chain name than mainnet)
  "eip155:84532|0x036cbd53842c5426634e7929541ec2318f3dcf7e": { name: "USDC", version: "2" },
  // World Chain mainnet — bridged Circle USDC (same domain shape as Base Sepolia)
  "eip155:480|0x79a02482a880bce3f13e09da970dc34db4cd24d1": { name: "USDC", version: "2" },
  // World Chain Sepolia — bridged test USDC
  "eip155:4801|0x66145f38cbac35ca6f1dfb4914df98f1614aea88": { name: "USDC", version: "2" },
};

function lookupEvmUsdcDomain(
  network: string,
  asset: string,
): { name: string; version: string } | undefined {
  return EVM_USDC_EIP712_DOMAINS[`${network}|${asset.toLowerCase()}`];
}

export interface CdpCapabilityConfig {
  /** CAIP-2 identifier, e.g. `eip155:8453`. */
  network: Caip2;
  /** Asset identifier — token contract address on EVM, mint on Solana. */
  asset: string;
  /** Scheme — `exact` or `upto` on EVM, `exact` on Solana. */
  scheme: string;
}

export interface CoinbaseCdpAdapterConfig {
  /** Defaults to `https://api.cdp.coinbase.com/platform/v2/x402`. */
  baseUrl?: string;
  /** CDP API key ID. Provider-internal env var, not exposed to gateway. */
  apiKeyName: string;
  /** CDP API key secret (base64 Ed25519). Provider-internal. */
  apiKeySecret: string;
  /** Static capabilities for this adapter instance. */
  capabilities: ReadonlyArray<CdpCapabilityConfig>;
  /** USD-denominated fee estimate per settled payment. */
  estimatedFeeUsd: string;
  /** Hard upper bound on monthly settlements. Default 5000. */
  monthlyHardCap?: number;
  /** Usage counter implementation. Defaults to an in-memory tracker. */
  usageTracker?: UsageTracker;
  /** Overridable signer (used in tests). Defaults to a jose Ed25519 signer. */
  signer?: CdpJwtSigner;
  displayName?: string;
  defaultTimeoutMs?: number;
  logger?: CdpLogger;
  fetchImpl?: typeof globalThis.fetch;
}

export class CoinbaseCdpAdapter extends BaseAdapter {
  readonly id = ADAPTER_ID;
  readonly displayName: string;

  private readonly baseUrl: string;
  private readonly host: string;
  private readonly basePath: string;
  private readonly capabilities: ReadonlyArray<CdpCapabilityConfig>;
  private readonly estimatedFeeUsd: string;
  private readonly monthlyHardCap: number;
  private readonly usageTracker: UsageTracker;
  private readonly signer: CdpJwtSigner;
  private readonly timeoutMs: number;
  private readonly logger: CdpLogger | undefined;
  private readonly fetchImpl: typeof globalThis.fetch | undefined;

  constructor(config: CoinbaseCdpAdapterConfig) {
    const staticCapabilities: StaticCapability[] = config.capabilities.map(
      (cap) => ({ network: cap.network, asset: cap.asset, scheme: cap.scheme }),
    );
    super({
      staticCapabilities,
      defaultTimeoutMs: config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    this.displayName = config.displayName ?? DEFAULT_DISPLAY_NAME;
    this.baseUrl = trimTrailingSlash(config.baseUrl ?? DEFAULT_BASE_URL);
    const parsed = parseUrl(this.baseUrl);
    this.host = parsed.host;
    this.basePath = parsed.path;
    this.capabilities = config.capabilities;
    this.estimatedFeeUsd = config.estimatedFeeUsd;
    this.monthlyHardCap = config.monthlyHardCap ?? DEFAULT_MONTHLY_HARD_CAP;
    this.usageTracker = config.usageTracker ?? new InMemoryUsageTracker();
    this.signer =
      config.signer ??
      createCdpJwtSigner({
        apiKeyName: config.apiKeyName,
        apiKeySecret: config.apiKeySecret,
      });
    this.timeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (config.logger !== undefined) this.logger = config.logger;
    if (config.fetchImpl !== undefined) this.fetchImpl = config.fetchImpl;
  }

  /**
   * Override default supports() to add the monthly hard-cap check.
   * Capability match is also tightened to the configured set.
   */
  override async supports(req: SupportQuery): Promise<SupportResult> {
    const matched = this.capabilities.some(
      (cap) =>
        cap.network === req.network &&
        cap.asset === req.asset &&
        cap.scheme === req.scheme,
    );
    if (!matched) {
      return { supported: false };
    }
    const used = await this.usageTracker.current();
    if (used >= this.monthlyHardCap) {
      return { supported: false, reason: "quota_exceeded" };
    }
    return { supported: true };
  }

  override async quote(req: QuoteRequest): Promise<QuoteResponse> {
    return {
      providerId: this.id,
      network: req.network,
      asset: req.asset,
      amount: req.amount,
      estimatedFeeUsd: this.estimatedFeeUsd,
      estimatedLatencyMs: 230,
      scheme: req.scheme,
      source: "synthetic",
    };
  }

  override async verify(req: VerifyRequest): Promise<VerifyResponse> {
    const verifiedAtIso = new Date().toISOString();
    const path = `${this.basePath}/verify`;
    const auth = await this.signer.sign({
      method: "POST",
      host: this.host,
      path,
    });
    const httpOpts = {
      method: "POST" as const,
      body: toCdpRequest(req),
      headers: { Authorization: `Bearer ${auth}` },
      timeoutMs: this.timeoutMs,
      providerId: this.id,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    };
    const { data, headers: respHeaders } = await httpJson<unknown>(`${this.baseUrl}/verify`, httpOpts);
    try {
      const hdrs = Object.fromEntries(respHeaders.entries());
      console.log(`[CDP-VERIFY-HEADERS] ${JSON.stringify(hdrs)}`);
      console.log(`[CDP-VERIFY-BODY] ${JSON.stringify(data)}`);
    } catch (e) { console.log("[CDP-VERIFY-HEADERS-ERR]", String(e)); }
    const parsed = CdpVerifyResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError(
        "provider_internal_error",
        `CDP /verify returned a malformed body: ${parsed.error.message}`,
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
    const errorCode = mapCdpErrorReason(v.invalidReason, {
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

  override async settle(
    req: SettleRequest,
    opts?: SettleOptions,
  ): Promise<SettleResponse> {
    const settledAtIso = new Date().toISOString();
    const networkFromReq = req.paymentRequirements.network;
    const amountFromReq = req.paymentRequirements.maxAmountRequired;
    const asset = req.paymentRequirements.asset;
    const path = `${this.basePath}/settle`;
    const auth = await this.signer.sign({
      method: "POST",
      host: this.host,
      path,
    });
    const httpOpts = {
      method: "POST" as const,
      body: toCdpRequest(req),
      headers: { Authorization: `Bearer ${auth}` },
      timeoutMs: this.timeoutMs,
      providerId: this.id,
      // Idempotency-Key is not part of CDP's documented x402 API but
      // is a Coinbase-wide convention; pass it through when supplied so
      // a future CDP-side implementation Just Works.
      ...(opts?.idempotencyKey !== undefined
        ? {
            idempotencyKey: opts.idempotencyKey,
            retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 2_000 },
          }
        : {}),
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    };
    const { data, headers: respHeaders } = await httpJson<unknown>(`${this.baseUrl}/settle`, httpOpts);
    try {
      const hdrs = Object.fromEntries(respHeaders.entries());
      console.log(`[CDP-SETTLE-HEADERS] ${JSON.stringify(hdrs)}`);
      console.log(`[CDP-SETTLE-BODY] ${JSON.stringify(data)}`);
    } catch (e) { console.log("[CDP-SETTLE-HEADERS-ERR]", String(e)); }
    const parsed = CdpSettleResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError(
        "provider_internal_error",
        `CDP /settle returned a malformed body: ${parsed.error.message}`,
        { providerId: this.id },
      );
    }
    const s = parsed.data;
    if (s.success) {
      await this.usageTracker.increment();
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
    const errorCode = mapCdpErrorReason(s.errorReason, {
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
   * CDP has no documented status endpoint. Status is reconstructed
   * from orchestrator-supplied hints, like cosmos-pay.
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
   * No documented /health endpoint on CDP's x402 facilitator. We hit
   * /supported with a short timeout — it's a small unauthenticated
   * (or near-unauthenticated) lookup that doubles as a liveness probe.
   * Auth is included anyway so a 401 also surfaces as "down".
   */
  override async healthCheck(): Promise<HealthStatus> {
    const fetchImpl = this.fetchImpl ?? globalThis.fetch;
    const startedAt = Date.now();
    const checkedAt = new Date(startedAt).toISOString();
    const path = `${this.basePath}/supported`;
    try {
      const auth = await this.signer.sign({
        method: "GET",
        host: this.host,
        path,
      });
      const response = await fetchImpl(`${this.baseUrl}/supported`, {
        method: "GET",
        headers: { Authorization: `Bearer ${auth}` },
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

  override async discoverCapabilities(): Promise<DiscoveredCapability[]> {
    const path = `${this.basePath}/supported`;
    const auth = await this.signer.sign({
      method: "GET",
      host: this.host,
      path,
    });
    const httpOpts = {
      method: "GET" as const,
      headers: { Authorization: `Bearer ${auth}` },
      timeoutMs: this.timeoutMs,
      providerId: this.id,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    };
    const { data } = await httpJson<unknown>(`${this.baseUrl}/supported`, httpOpts);
    const parsed = CdpSupportedResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError(
        "provider_internal_error",
        `CDP /supported returned a malformed body: ${parsed.error.message}`,
        { providerId: this.id },
      );
    }
    // CDP's /supported response carries (scheme, network) only — no
    // asset. Cross-join discovered (scheme, network) pairs with our
    // statically-configured capabilities to attach the right asset.
    const warn = this.logger?.warn.bind(this.logger) ?? defaultWarn;
    const out: DiscoveredCapability[] = [];
    for (const kind of parsed.data.kinds) {
      const matches = this.capabilities.filter(
        (cap) => cap.network === kind.network && cap.scheme === kind.scheme,
      );
      if (matches.length === 0) {
        warn(
          `CDP /supported lists (${kind.scheme}, ${kind.network}) but adapter has no asset configured; skipping`,
          { network: kind.network, scheme: kind.scheme },
        );
        continue;
      }
      // CDP's upstream /supported publishes per-kind `extra` — EVM
      // entries carry the EIP-712 USDC domain `{ name, version }` and
      // Solana entries carry the facilitator's `{ feePayer }` co-signer
      // pubkey. Pass through verbatim so the gateway's
      // /facilitator/supported response surfaces them and sellers'
      // x402-server middleware can auto-merge them into 402 challenges
      // (PR-B and onwards). Empty objects are dropped to avoid noise.
      //
      // When CDP omits the per-kind `extra` for an EVM USDC kind we
      // already know the on-chain DOMAIN for, fall back to a static
      // adapter-side lookup. This is the load-bearing fallback CDP
      // requires to verify EVM payments — without it /verify dead-ends
      // with "missing EIP-712 domain name/version in requirements.extra"
      // even when the buyer's signature is mathematically valid.
      for (const cap of matches) {
        const cdpExtra =
          kind.extra !== undefined && Object.keys(kind.extra).length > 0
            ? kind.extra
            : undefined;
        const fallback = cdpExtra === undefined
          ? lookupEvmUsdcDomain(cap.network, cap.asset)
          : undefined;
        const extra = cdpExtra ?? fallback;
        out.push({
          network: cap.network,
          asset: cap.asset,
          scheme: cap.scheme,
          ...(extra !== undefined ? { extra } : {}),
        });
      }
    }
    return out;
  }
}

function toCdpRequest(req: VerifyRequest | SettleRequest): unknown {
  const payload = req.paymentPayload as Record<string, unknown>;
  const x402Version =
    typeof payload["x402Version"] === "number"
      ? (payload["x402Version"] as number)
      : 2;
  // CDP's hosted facilitator implements x402V2PaymentRequirements with
  // `amount` rather than the spec's `maxAmountRequired`, AND requires
  // an `accepted` field embedded inside the paymentPayload (the
  // requirements the payer committed to). The wider gateway uses the
  // x402 spec field names; this adapter translates to/from CDP's
  // internal shape so the rest of the codebase stays spec-aligned.
  // Verified empirically against api.cdp.coinbase.com/platform/v2/x402
  // on 2026-05-28 — sending the canonical spec shape returns HTTP 400
  // with `must match one of [x402V2PaymentPayload, x402V1PaymentPayload].
  // x402V2PaymentPayload requires 'accepted'`.
  const cdpRequirements = toCdpRequirements(req.paymentRequirements);
  // Build a clean v2 paymentPayload matching the shape CDP's bazaar
  // crawler indexes by (mirrors what GovHub's Python facilitator sends
  // verbatim — proven to index in ~7s on api.suverse.io). Three deltas
  // vs the prior naive spread:
  //   1) keep `payload` (inner signed authorization) only; drop the
  //      v1-flat `scheme`/`network` top-levels our gateway middleware
  //      added — CDP ignores them in v2 but they clutter the envelope.
  //   2) lift any flattened `resource`/`description`/`mimeType` fields
  //      out of `accepted` into a top-level `resource` object.
  //   3) preserve `extensions` (e.g. `extensions.bazaar`) — the gateway
  //      now forwards them via the `extensions` field on paymentPayload;
  //      without this the bazaar discovery hint never reaches CDP and
  //      the URL is never indexed.
  const v2Payload: Record<string, unknown> = {
    x402Version,
    payload: payload["payload"],
    accepted: cdpRequirements,
  };
  // Resource object: prefer an explicit `resource` object on the inbound
  // payload, else reconstruct from flattened fields in `accepted`/the
  // requirement (resource URL is `paymentRequirements.resource` per spec).
  const inboundResource = payload["resource"];
  if (
    inboundResource !== undefined &&
    typeof inboundResource === "object" &&
    inboundResource !== null
  ) {
    v2Payload["resource"] = inboundResource;
  } else {
    const reqs = req.paymentRequirements as Record<string, unknown>;
    const url = reqs["resource"];
    if (typeof url === "string" && url !== "") {
      v2Payload["resource"] = {
        url,
        ...(typeof reqs["description"] === "string"
          ? { description: reqs["description"] }
          : {}),
        ...(typeof reqs["mimeType"] === "string"
          ? { mimeType: reqs["mimeType"] }
          : {}),
      };
    }
  }
  // Extensions: the gateway forwards opts.extensions on the inbound
  // /verify, /settle envelope; the orchestrator's PaymentPayloadSchema
  // preserves it (passthrough field). Pass through verbatim to CDP.
  if (
    payload["extensions"] !== undefined &&
    typeof payload["extensions"] === "object" &&
    payload["extensions"] !== null
  ) {
    v2Payload["extensions"] = payload["extensions"];
  }
  return {
    x402Version,
    paymentPayload: v2Payload,
    paymentRequirements: cdpRequirements,
  };
}

function toCdpRequirements(
  req: VerifyRequest["paymentRequirements"],
): Record<string, unknown> {
  const { maxAmountRequired, ...rest } = req as Record<string, unknown> & {
    maxAmountRequired: string;
  };
  return { ...rest, amount: maxAmountRequired };
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function parseUrl(url: string): { host: string; path: string } {
  const u = new URL(url);
  return { host: u.host, path: u.pathname.replace(/\/$/, "") };
}

function defaultWarn(message: string, context?: Record<string, unknown>): void {
  if (context !== undefined) {
    console.warn(`[coinbase-cdp-adapter] ${message}`, context);
  } else {
    console.warn(`[coinbase-cdp-adapter] ${message}`);
  }
}
