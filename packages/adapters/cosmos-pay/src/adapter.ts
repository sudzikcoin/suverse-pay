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
import { mapCosmosPayErrorReason, type CosmosPayLogger } from "./error-map.js";
import {
  CosmosPaySettleResponseSchema,
  CosmosPaySupportedResponseSchema,
  CosmosPayVerifyResponseSchema,
} from "./wire.js";

const ADAPTER_ID = "cosmos-pay";
const DEFAULT_DISPLAY_NAME = "Suverse Cosmos Facilitator";
const DEFAULT_TIMEOUT_MS = 10_000;
const HEALTHCHECK_TIMEOUT_MS = 5_000;
const X402_VERSION = 2;
const SCHEME = "exact_cosmos_authz";

export interface CosmosPayAdapterConfig {
  baseUrl: string;
  /**
   * Maps each Caip2 network the upstream cosmos-pay supports to the
   * bank denoms we will accept for that network. cosmos-pay's
   * `/supported` endpoint only returns `(scheme, network)` pairs — no
   * `asset` — so the adapter cross-joins discovered networks with this
   * map. Networks discovered but absent from this map are skipped with
   * a warning.
   *
   * Example for Noble: `{ "cosmos:noble-1": ["uusdc"] }`.
   */
  networkAssets: Readonly<Record<Caip2, ReadonlyArray<string>>>;
  estimatedFeeUsd: string;
  displayName?: string;
  defaultTimeoutMs?: number;
  logger?: CosmosPayLogger;
  fetchImpl?: typeof globalThis.fetch;
  /**
   * Public bech32 address of the cosmos-pay facilitator's on-chain
   * grantee. Buyers signing `exact_cosmos_authz` need this in their
   * payment payload's `extra.facilitator` so the facilitator's
   * `MsgGrant` lookup uses the right grantee. The upstream cosmos-pay
   * binary's `/supported` does NOT publish it today, so the operator
   * supplies it as adapter config (config-injection — single source of
   * truth remains the cosmos-pay binary's env). When omitted, the
   * adapter surfaces no Cosmos extras and sellers must continue to
   * hardcode `extra.facilitator` in their `acceptedPayments` (the
   * pre-PR-A behavior).
   *
   * Example: `"noble18jq3tgk39z8qk5jz304zqkhd02gs5zkhrj7sqt"`.
   */
  granteeAddress?: string;
}

export class CosmosPayAdapter extends BaseAdapter {
  readonly id = ADAPTER_ID;
  readonly displayName: string;

  private readonly baseUrl: string;
  private readonly estimatedFeeUsd: string;
  private readonly networkAssets: Readonly<Record<Caip2, ReadonlyArray<string>>>;
  private readonly timeoutMs: number;
  private readonly logger: CosmosPayLogger | undefined;
  private readonly fetchImpl: typeof globalThis.fetch | undefined;
  private readonly granteeAddress: string | undefined;

  constructor(config: CosmosPayAdapterConfig) {
    const staticCapabilities: StaticCapability[] = [];
    for (const [network, assets] of Object.entries(config.networkAssets)) {
      for (const asset of assets) {
        staticCapabilities.push({ network: network as Caip2, asset, scheme: SCHEME });
      }
    }
    super({
      staticCapabilities,
      defaultTimeoutMs: config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    this.displayName = config.displayName ?? DEFAULT_DISPLAY_NAME;
    this.baseUrl = trimTrailingSlash(config.baseUrl);
    this.estimatedFeeUsd = config.estimatedFeeUsd;
    this.networkAssets = config.networkAssets;
    this.timeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (config.logger !== undefined) this.logger = config.logger;
    if (config.fetchImpl !== undefined) this.fetchImpl = config.fetchImpl;
    if (config.granteeAddress !== undefined && config.granteeAddress.length > 0) {
      this.granteeAddress = config.granteeAddress;
    }
  }

  /**
   * Synthetic quote: cosmos-pay exposes no /quote endpoint. We return
   * the adapter's configured fee + a coarse latency estimate. The
   * orchestrator may refine the latency from recent health-check
   * history.
   */
  override async quote(req: QuoteRequest): Promise<QuoteResponse> {
    return {
      providerId: this.id,
      network: req.network,
      asset: req.asset,
      amount: req.amount,
      estimatedFeeUsd: this.estimatedFeeUsd,
      estimatedLatencyMs: 400,
      scheme: req.scheme,
      source: "synthetic",
    };
  }

  override async verify(req: VerifyRequest): Promise<VerifyResponse> {
    const body = toCosmosPayRequest(req);
    const startedAt = Date.now();
    const verifiedAtIso = new Date(startedAt).toISOString();
    const httpOpts = {
      method: "POST" as const,
      body,
      timeoutMs: this.timeoutMs,
      providerId: this.id,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    };
    const { data } = await httpJson<unknown>(`${this.baseUrl}/verify`, httpOpts);
    const parsed = CosmosPayVerifyResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError(
        "provider_internal_error",
        `cosmos-pay /verify returned a malformed body: ${parsed.error.message}`,
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
    const errorCode = mapCosmosPayErrorReason(v.invalidReason, {
      ...(this.logger !== undefined ? { logger: this.logger } : {}),
      context: { endpoint: "/verify", invalidReason: v.invalidReason },
    });
    return {
      valid: false,
      providerId: this.id,
      ...(v.payer !== undefined ? { payer: v.payer } : {}),
      verifiedAt: verifiedAtIso,
      errorCode,
      ...(v.invalidReason !== undefined ? { errorMessage: v.invalidReason } : {}),
    };
  }

  /**
   * Settle a payment by forwarding to cosmos-pay's /settle.
   *
   * IMPORTANT: internal retry is enabled ONLY when the caller supplies
   * an `idempotencyKey`. Without a key, a retry across a transient 5xx
   * could double-settle (cosmos-pay's on-chain nonce protects against
   * the broadcast race, but its `/settle` is otherwise non-idempotent
   * at the HTTP layer). With a key, the same `Idempotency-Key` header
   * is sent on every attempt — see
   * `@suverse-pay/provider-sdk/http-json` for the propagation guard.
   */
  override async settle(
    req: SettleRequest,
    opts?: SettleOptions,
  ): Promise<SettleResponse> {
    const body = toCosmosPayRequest(req);
    const settledAtIso = new Date().toISOString();
    const networkFromReq = req.paymentRequirements.network;
    const amount = req.paymentRequirements.maxAmountRequired;
    const asset = req.paymentRequirements.asset;
    const httpOpts = {
      method: "POST" as const,
      body,
      timeoutMs: this.timeoutMs,
      providerId: this.id,
      ...(opts?.idempotencyKey !== undefined
        ? {
            idempotencyKey: opts.idempotencyKey,
            // Retry only when an idempotency key guards against
            // duplicate settlement downstream.
            retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 2_000 },
          }
        : {}),
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    };
    const { data } = await httpJson<unknown>(`${this.baseUrl}/settle`, httpOpts);
    const parsed = CosmosPaySettleResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError(
        "provider_internal_error",
        `cosmos-pay /settle returned a malformed body: ${parsed.error.message}`,
        { providerId: this.id },
      );
    }
    const s = parsed.data;
    if (s.success) {
      return {
        settled: true,
        providerId: this.id,
        ...(s.transaction !== undefined ? { txHash: s.transaction } : {}),
        network: networkFromReq,
        amount,
        asset,
        ...(s.payer !== undefined ? { payer: s.payer } : {}),
        settledAt: settledAtIso,
      };
    }
    const errorCode = mapCosmosPayErrorReason(s.errorReason, {
      ...(this.logger !== undefined ? { logger: this.logger } : {}),
      context: { endpoint: "/settle", errorReason: s.errorReason },
    });
    return {
      settled: false,
      providerId: this.id,
      network: networkFromReq,
      amount,
      asset,
      ...(s.payer !== undefined ? { payer: s.payer } : {}),
      errorCode,
      ...(s.errorReason !== undefined ? { errorMessage: s.errorReason } : {}),
    };
  }

  /**
   * cosmos-pay has no native status endpoint — `/settle` is synchronous
   * and the response is the canonical truth. The orchestrator owns the
   * payment record and passes whatever it knows via `hints`; we
   * reconstruct status from those without taking a DB dependency in
   * the adapter.
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
   * Pings cosmos-pay's `/healthz` (empty 200). Uses `fetch` directly
   * rather than `httpJson` because the response has no body; we just
   * want status + latency.
   */
  override async healthCheck(): Promise<HealthStatus> {
    const fetchImpl = this.fetchImpl ?? globalThis.fetch;
    const startedAt = Date.now();
    const checkedAt = new Date(startedAt).toISOString();
    try {
      const response = await fetchImpl(`${this.baseUrl}/healthz`, {
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
   * GET /supported, cross-join with `networkAssets`. Networks the
   * upstream lists but that we have no configured asset for are
   * skipped with a warning (we can't safely transact without knowing
   * the bank denom).
   */
  override async discoverCapabilities(): Promise<DiscoveredCapability[]> {
    const httpOpts = {
      method: "GET" as const,
      timeoutMs: this.timeoutMs,
      providerId: this.id,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    };
    const { data } = await httpJson<unknown>(`${this.baseUrl}/supported`, httpOpts);
    const parsed = CosmosPaySupportedResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError(
        "provider_internal_error",
        `cosmos-pay /supported returned a malformed body: ${parsed.error.message}`,
        { providerId: this.id },
      );
    }
    const out: DiscoveredCapability[] = [];
    const warn = this.logger?.warn.bind(this.logger) ?? defaultWarn;
    for (const pair of parsed.data.kinds) {
      const assets = this.networkAssets[pair.network as Caip2];
      if (assets === undefined || assets.length === 0) {
        warn(
          `cosmos-pay /supported lists network "${pair.network}" but adapter has no asset configured; skipping`,
          { network: pair.network, scheme: pair.scheme },
        );
        continue;
      }
      // Build the per-kind `extra` once per network. Buyer's
      // `exact_cosmos_authz` signer needs:
      //   - `facilitator` — grantee bech32 (from config-injection)
      //   - `chainId`     — bare chain id (e.g. "noble-1")
      //   - `decimals`    — denom decimals (6 for Noble bank tokens)
      //   - `symbol`      — display symbol derived from denom
      // We emit `extra` only when the operator supplied a grantee
      // address. Without it we preserve the pre-PR-A behavior (no
      // extras on the kind) so sellers' hardcoded `extra.facilitator`
      // continues to flow through unchanged.
      const chainId = pair.network.startsWith("cosmos:")
        ? pair.network.slice("cosmos:".length)
        : pair.network;
      for (const asset of assets) {
        out.push({
          network: pair.network as Caip2,
          asset,
          scheme: pair.scheme,
          ...(this.granteeAddress !== undefined
            ? {
                extra: {
                  facilitator: this.granteeAddress,
                  chainId,
                  decimals: 6,
                  symbol: denomSymbol(asset),
                },
              }
            : {}),
        });
      }
    }
    return out;
  }

  override async supports(req: SupportQuery): Promise<SupportResult> {
    if (req.scheme !== SCHEME) {
      return { supported: false, reason: "unsupported_scheme" };
    }
    const assets = this.networkAssets[req.network];
    if (assets === undefined) {
      return { supported: false };
    }
    if (!assets.includes(req.asset)) {
      return { supported: false };
    }
    return { supported: true };
  }
}

function toCosmosPayRequest(req: VerifyRequest | SettleRequest): unknown {
  // cosmos-pay's VerifyRequest has a top-level `x402Version`; our
  // internal type carries the version inside `paymentPayload`. Use the
  // value from the payload if present, else default to X402_VERSION.
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

/**
 * Derive a human-readable token symbol from a Cosmos SDK bank denom.
 * Noble bank denoms are `u<symbol>` lower-cased (e.g. `uusdc` → USDC,
 * `uusdt` → USDT). Anything not matching the `u…` pattern is
 * upper-cased verbatim so the resulting symbol is never empty.
 */
function denomSymbol(denom: string): string {
  if (denom.length > 1 && denom.startsWith("u")) {
    return denom.slice(1).toUpperCase();
  }
  return denom.toUpperCase();
}

function defaultWarn(message: string, context?: Record<string, unknown>): void {
  if (context !== undefined) {
    console.warn(`[cosmos-pay-adapter] ${message}`, context);
  } else {
    console.warn(`[cosmos-pay-adapter] ${message}`);
  }
}
