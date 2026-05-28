import {
  ProviderError,
  isRetryableErrorCode,
  type SettleRequest,
  type SettleResponse,
  type VerifyRequest,
  type VerifyResponse,
} from "@suverse-pay/core-types";
import type { ProviderRegistry, RegisteredProvider } from "@suverse-pay/orchestrator";
import { getRoutingPriority } from "./routing-config.js";

export interface FacilitatorRouterDeps {
  registry: ProviderRegistry;
  logger?: {
    info: (msg: string, ctx?: Record<string, unknown>) => void;
    warn: (msg: string, ctx?: Record<string, unknown>) => void;
  };
}

export interface PickAdaptersResult {
  /** Ordered list of healthy adapters that can handle this route. */
  candidates: RegisteredProvider[];
  /** Reason field surfaced when `candidates` is empty. */
  reason?:
    | "no_routing_config"
    | "no_registered_adapter"
    | "no_enabled_adapter";
}

/**
 * Pick ordered candidate adapters for a (network, scheme) route from
 * the static routing config, intersected with the registry of
 * currently-registered, enabled adapters. The orchestrator already
 * filters out disabled adapters via `registry.enabled()` — we then
 * preserve the priority order from `routing-config.ts`.
 */
export function pickAdaptersForRoute(
  registry: ProviderRegistry,
  args: { network: string; scheme: string },
): PickAdaptersResult {
  const priority = getRoutingPriority(args.network, args.scheme);
  if (priority === undefined || priority.length === 0) {
    return { candidates: [], reason: "no_routing_config" };
  }
  const candidates: RegisteredProvider[] = [];
  let foundAnyRegistered = false;
  for (const adapterId of priority) {
    const reg = registry.getById(adapterId);
    if (reg === undefined) continue;
    foundAnyRegistered = true;
    if (!reg.enabled) continue;
    candidates.push(reg);
  }
  if (candidates.length === 0) {
    return {
      candidates: [],
      reason: foundAnyRegistered ? "no_enabled_adapter" : "no_registered_adapter",
    };
  }
  return { candidates };
}

export interface RouteVerifyResult {
  response: VerifyResponse;
  adapterUsed: string;
}

/**
 * Run /verify against the primary adapter only. Verify is read-only
 * and stateless — no failover. If the primary fails or rejects, that
 * IS the answer.
 */
export async function routeVerify(
  registry: ProviderRegistry,
  req: VerifyRequest,
): Promise<RouteVerifyResult> {
  const { candidates, reason } = pickAdaptersForRoute(registry, {
    network: req.paymentRequirements.network,
    scheme: req.paymentRequirements.scheme,
  });
  if (candidates.length === 0) {
    throw new ProviderError(
      "route_unsupported",
      `no facilitator available for ${req.paymentRequirements.network} / ${req.paymentRequirements.scheme} (${reason ?? "unknown"})`,
    );
  }
  const primary = candidates[0]!;
  const response = await primary.adapter.verify(req);
  return { response, adapterUsed: primary.id };
}

export interface FailoverAttempt {
  adapterId: string;
  errorCode: string;
  errorMessage: string | undefined;
}

export interface RouteSettleResult {
  response: SettleResponse;
  adapterUsed: string;
  /** Empty when the primary succeeded; populated when we fell over. */
  failoverFrom: FailoverAttempt[];
}

export interface RouteSettleDeps {
  registry: ProviderRegistry;
  /** Idempotency key passed to every adapter attempt — reuses are deliberate. */
  idempotencyKey: string;
  logger?: FacilitatorRouterDeps["logger"];
}

/**
 * Run /settle against the routing-config candidates, falling over on
 * retryable errors. The idempotency key is REUSED across attempts so
 * that adapters which honour it cannot double-broadcast.
 *
 * Failover triggers:
 *   - ProviderError thrown with isRetryable() === true
 *   - Settled=false response with a retryable errorCode
 *   - Settled=true response with empty txHash (treated as error)
 *
 * Failover does NOT trigger on:
 *   - Terminal errors (invalid_signature, expired_authorization, etc.)
 *   - Successful settle with a txHash
 *
 * Returns the final response + the list of failed attempts so the
 * caller can record failover events in the audit log.
 */
export async function routeSettleWithFailover(
  req: SettleRequest,
  deps: RouteSettleDeps,
): Promise<RouteSettleResult> {
  const { candidates, reason } = pickAdaptersForRoute(deps.registry, {
    network: req.paymentRequirements.network,
    scheme: req.paymentRequirements.scheme,
  });
  if (candidates.length === 0) {
    throw new ProviderError(
      "route_unsupported",
      `no facilitator available for ${req.paymentRequirements.network} / ${req.paymentRequirements.scheme} (${reason ?? "unknown"})`,
    );
  }

  const failoverFrom: FailoverAttempt[] = [];
  let lastResponse: SettleResponse | null = null;
  let lastError: { code: string; message: string | undefined } | null = null;

  for (let i = 0; i < candidates.length; i += 1) {
    const adapter = candidates[i]!;
    let response: SettleResponse | null = null;
    try {
      response = await adapter.adapter.settle(req, {
        idempotencyKey: deps.idempotencyKey,
      });
    } catch (err) {
      const code = err instanceof ProviderError ? err.code : "provider_internal_error";
      const message = err instanceof Error ? err.message : String(err);
      lastError = { code, message };
      // Retryable error → record + try next adapter.
      if (isRetryableErrorCode(code) && i < candidates.length - 1) {
        failoverFrom.push({
          adapterId: adapter.id,
          errorCode: code,
          errorMessage: message,
        });
        deps.logger?.warn("facilitator settle failover", {
          fromAdapter: adapter.id,
          toAdapter: candidates[i + 1]!.id,
          errorCode: code,
        });
        continue;
      }
      // Terminal error or last adapter → bubble up via response shape.
      return {
        response: {
          settled: false,
          providerId: adapter.id,
          network: req.paymentRequirements.network,
          amount: req.paymentRequirements.maxAmountRequired,
          asset: req.paymentRequirements.asset,
          errorCode: code,
          errorMessage: message,
        } as SettleResponse,
        adapterUsed: adapter.id,
        failoverFrom,
      };
    }

    if (response.settled === true) {
      const hasTxHash = typeof response.txHash === "string" && response.txHash.length > 0;
      if (!hasTxHash) {
        // Pathological success — facilitator says yes but gives us
        // nothing on-chain. Treat as broadcast_failed and try the
        // next adapter.
        lastError = { code: "broadcast_failed", message: "facilitator returned settled=true with empty txHash" };
        if (i < candidates.length - 1) {
          failoverFrom.push({
            adapterId: adapter.id,
            errorCode: "broadcast_failed",
            errorMessage: lastError.message,
          });
          continue;
        }
      }
      return {
        response,
        adapterUsed: adapter.id,
        failoverFrom,
      };
    }

    // settled=false. Check error code retryability.
    const code = response.errorCode ?? "provider_internal_error";
    const message = response.errorMessage;
    lastError = { code, message };
    lastResponse = response;
    if (isRetryableErrorCode(code) && i < candidates.length - 1) {
      failoverFrom.push({
        adapterId: adapter.id,
        errorCode: code,
        errorMessage: message,
      });
      deps.logger?.warn("facilitator settle failover", {
        fromAdapter: adapter.id,
        toAdapter: candidates[i + 1]!.id,
        errorCode: code,
      });
      continue;
    }
    // Terminal error from this adapter → return the response as the
    // final answer.
    return {
      response,
      adapterUsed: adapter.id,
      failoverFrom,
    };
  }

  // All candidates exhausted with retryable errors → return the last
  // observed response, augmented to reference the LAST attempted
  // adapter.
  const lastAdapter = candidates[candidates.length - 1]!;
  return {
    response:
      lastResponse ??
      ({
        settled: false,
        providerId: lastAdapter.id,
        network: req.paymentRequirements.network,
        amount: req.paymentRequirements.maxAmountRequired,
        asset: req.paymentRequirements.asset,
        errorCode: lastError?.code ?? "provider_internal_error",
        errorMessage: lastError?.message,
      } as SettleResponse),
    adapterUsed: lastAdapter.id,
    failoverFrom,
  };
}
