/**
 * Per-request handler shared by all five HTTP methods. Pulled out of
 * index.ts so the unit tests can drive it directly without a live
 * Fastify instance.
 *
 * Flow:
 *   1. Look up config by (resourceKeyId, slug).
 *   2. Reject if missing / paused / unconfigured (no networks, no
 *      payTo for the namespaces selected).
 *   3. Build the AcceptedPayment[] from accepted_networks + payTo
 *      addresses + price.
 *   4. Run `@suverselabs/x402-server`'s `runProtocol()` against the
 *      caller's PAYMENT-SIGNATURE / X-PAYMENT header.
 *      - challenge / rejected → 402 (or 4xx) with the challenge body
 *      - accepted              → settled, continue
 *   5. Decrypt forward headers, call the upstream API with the
 *      caller's original body + method, stream the upstream response
 *      back to the buyer with the PAYMENT-RESPONSE metadata header
 *      attached.
 *   6. Log to proxy_request_logs.
 */

import { createHash } from "node:crypto";
import { runProtocol } from "@suverselabs/x402-server";
import type {
  AcceptedPayment,
  MiddlewareOptions,
} from "@suverselabs/x402-server";
import type { Pool } from "pg";
import { buildBazaarExtension } from "./bazaar.js";
import { decryptHeaders } from "./crypto.js";
import {
  getInternalHandler,
  getInternalHandlerValidator,
} from "./handlers/registry.js";
import { lookupNetwork } from "./networks.js";
import {
  createInboundFacilitatorPaymentFallback,
  findInboundFacilitatorPaymentByTxHash,
  finishOutboundUpstreamPayment,
  logProxyRequest,
  startOutboundUpstreamPayment,
  type CatalogBazaarStore,
  type ProxyConfigRow,
  type ProxyConfigStore,
  type ProxyOutcome,
} from "./store.js";
import { recordRefundPending } from "./refunds.js";
import { checkUpstreamHealth } from "./upstream-health.js";
import {
  callUpstreamWithX402,
  type OutboundRecorder,
  type RefundPendingRecorder,
  type ServiceAddresses,
} from "./upstream-x402.js";
import type { SuverseClient } from "@suverselabs/x402-client";

/** Headers we never forward to the upstream — they belong to the proxy. */
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailers",
  // x402 / payment-related — only the proxy needs these.
  "x-payment",
  "payment-signature",
  "payment-required",
  "payment-response",
  "x-payment-response",
  "idempotency-key",
  // Auth headers belong to the SELLER (forwarded from the encrypted
  // config) not the buyer.
  "authorization",
  "cookie",
  // Infrastructure headers added by nginx in front of us — leaking
  // them to the upstream advertises that the request is double-
  // proxied. Cloudflare-fronted APIs (CoinGecko etc.) treat that as
  // a bot signal and return 403; standard reverse-proxy hygiene is
  // to terminate them here and emit only canonical `X-Forwarded-For`
  // if the seller wants it (we don't, in v1).
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
]);

export interface HandleArgs {
  resourceKeyId: string;
  slug: string;
  method: string;
  /** Absolute URL of the incoming request, used as resource URL. */
  resourceUrl: string;
  /** Raw payment header value, or undefined if absent. */
  paymentHeader: string | undefined;
  idempotencyKey: string | undefined;
  /** All request headers as a flat map. Caller normalises array → first. */
  incomingHeaders: Record<string, string>;
  /** Raw request body. May be null for GET. */
  body: Buffer | null;
  /** Client IP, used for the ip_hash audit column + rate limit key. */
  clientIp: string | null;
}

export interface HandleResult {
  /** Final HTTP status to return to the buyer. */
  status: number;
  /** Response body (parsed JSON or Buffer). */
  body: unknown;
  /** Response headers to set on the wire. */
  headers: Record<string, string>;
  outcome: ProxyOutcome;
}

export interface HandleDeps {
  store: ProxyConfigStore;
  /**
   * Catalog metadata lookup for the bazaar discovery extension.
   * Optional — when absent, the 402 challenge omits
   * `extensions.bazaar` entirely (CDP's crawler then skips the
   * route, which is the right outcome for an un-cataloged proxy).
   */
  catalogStore?: CatalogBazaarStore;
  pool: Pool;
  masterKey: Buffer;
  facilitatorUrl: string;
  /** Resource API key, sent as Bearer to the facilitator. */
  facilitatorApiKey: string;
  /** Injection seam for tests. */
  fetchImpl?: typeof fetch;
  /** Optional log sink — pino logger or console. */
  logger?: Pick<Console, "info" | "warn" | "error">;
  /**
   * Upstream health probe budget (ms). Only used when the incoming
   * request carries no X-Payment header — once a buyer has decided
   * to pay, we let the upstream call surface its own error rather
   * than blocking on a probe.
   */
  healthCheckTimeoutMs?: number;
  /**
   * Optional upstream-x402 buyer client. Required only when at least
   * one configured proxy row has `upstream_x402_enabled = true`. When
   * absent, those rows fall through to the plain upstream path and
   * the proxy will return the upstream's raw 402 to the buyer (which
   * is wrong but observable — boot logs flag the missing client).
   */
  upstreamX402Client?: SuverseClient;
  /** Public addresses of the service wallets, indexed by namespace. */
  upstreamServiceAddresses?: ServiceAddresses;
}

/** Result returned to the Fastify adapter — flattened for clarity. */
export async function handle(
  args: HandleArgs,
  deps: HandleDeps,
): Promise<HandleResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const ipHash = hashIp(args.clientIp);

  const config = await deps.store.lookup(args.resourceKeyId, args.slug);
  if (config === null) {
    return {
      status: 404,
      body: { error: "proxy_endpoint_not_found" },
      headers: { "content-type": "application/json" },
      outcome: "invalid_config",
    };
  }

  if (!config.isActive) {
    await logProxyRequest(deps.pool, {
      proxyConfigId: config.id,
      resourceKeyId: config.resourceKeyId,
      outcome: "paused",
      ipHash,
    });
    return {
      status: 503,
      body: { error: "endpoint_paused" },
      headers: { "content-type": "application/json", "retry-after": "60" },
      outcome: "paused",
    };
  }

  if (config.originalMethod !== args.method.toUpperCase()) {
    return {
      status: 405,
      body: {
        error: "method_not_allowed",
        allow: config.originalMethod,
      },
      headers: {
        "content-type": "application/json",
        allow: config.originalMethod,
      },
      outcome: "invalid_config",
    };
  }

  // P2 pre-payment body validation. When the proxy endpoint is backed
  // by an internal handler that registered a validator, run it BEFORE
  // the 402 challenge. Bot probes with empty / malformed bodies get a
  // clean 400 and never see the 402 prompt — they stop retrying,
  // which keeps the published error rate clean for legitimate buyers.
  //
  // `outcome: "invalid_config"` is the closest existing prl outcome
  // for "client sent unusable input". It's deliberately excluded from
  // the dashboard's error-rate query (errors = settle_failed +
  // upstream_error) so this branch does not pollute reputation.
  if (config.internalHandler) {
    const validator = getInternalHandlerValidator(config.internalHandler);
    if (validator) {
      const rejection = validator(args.body, args.method.toUpperCase());
      if (rejection) {
        await logProxyRequest(deps.pool, {
          proxyConfigId: config.id,
          resourceKeyId: config.resourceKeyId,
          outcome: "invalid_config",
          errorCode: "client_invalid_body",
          ipHash,
        });
        return {
          status: rejection.status,
          body: rejection.body,
          headers: { "content-type": "application/json" },
          outcome: "invalid_config",
        };
      }
    }
  }

  const accepted = buildAcceptedPayments(config);
  if (accepted.length === 0) {
    await logProxyRequest(deps.pool, {
      proxyConfigId: config.id,
      resourceKeyId: config.resourceKeyId,
      outcome: "invalid_config",
      errorCode: "no_accepted_payments",
      ipHash,
    });
    return {
      status: 503,
      body: { error: "endpoint_misconfigured" },
      headers: { "content-type": "application/json" },
      outcome: "invalid_config",
    };
  }

  // Pre-charge upstream health probe. Only runs when the buyer
  // hasn't sent payment yet — i.e. the request that would otherwise
  // get a 402 challenge. If the buyer is already paying, we let
  // runProtocol + the upstream call play out so they see real
  // upstream errors (and the existing `outcome: "upstream_error"`
  // logging) rather than getting blocked by a probe.
  //
  // Internal handlers have no external upstream to probe — skip.
  const noPaymentHeader =
    args.paymentHeader === undefined || args.paymentHeader.trim() === "";
  if (noPaymentHeader && !config.internalHandler) {
    const probe = await checkUpstreamHealth({
      url: config.originalUrl,
      fetchImpl,
      ...(deps.healthCheckTimeoutMs !== undefined
        ? { timeoutMs: deps.healthCheckTimeoutMs }
        : {}),
      ...(deps.logger ? { logger: deps.logger } : {}),
    });
    if (!probe.ok) {
      deps.logger?.warn?.(
        `proxy: upstream health probe failed config=${config.id} ` +
          `url=${config.originalUrl} reason=${probe.reason ?? "?"} ` +
          `status=${probe.status ?? "?"} latencyMs=${probe.latencyMs}`,
      );
      await logProxyRequest(deps.pool, {
        proxyConfigId: config.id,
        resourceKeyId: config.resourceKeyId,
        outcome: "upstream_error",
        upstreamStatus: probe.status ?? null,
        upstreamLatencyMs: probe.latencyMs,
        errorCode: `upstream_health_${probe.reason ?? "unknown"}`,
        ipHash,
      });
      return {
        status: 503,
        body: {
          error: "upstream_unavailable",
          reason: probe.reason ?? "unknown",
          ...(probe.status !== undefined ? { upstreamStatus: probe.status } : {}),
        },
        headers: {
          "content-type": "application/json",
          "retry-after": "30",
        },
        outcome: "upstream_error",
      };
    }
    deps.logger?.info?.(
      `proxy: upstream health ok config=${config.id} ` +
        `status=${probe.status} method=${probe.method} latencyMs=${probe.latencyMs}`,
    );
  }

  // Bazaar discovery extension — read from the catalog listing if
  // this proxy has an approved one. Cached in-process; one DB hit
  // per 60s per endpoint URL. Failure is non-fatal: the 402 is still
  // served, CDP's crawler just won't catalog the route.
  let bazaarExtension: Record<string, unknown> | undefined;
  if (deps.catalogStore) {
    try {
      const catalogRow = await deps.catalogStore.lookup(args.resourceUrl);
      if (catalogRow) {
        const ext = buildBazaarExtension(catalogRow);
        if (ext) bazaarExtension = ext;
      }
    } catch (err) {
      deps.logger?.warn?.(
        `proxy: catalog bazaar lookup failed for ${args.resourceUrl}`,
        err,
      );
    }
  }

  const middlewareOpts: MiddlewareOptions = {
    apiKey: deps.facilitatorApiKey,
    facilitator: deps.facilitatorUrl,
    acceptedPayments: accepted,
    description: config.description ?? config.displayName ?? undefined,
    x402Version: 2,
    settle: true,
    fetchImpl,
    logger: deps.logger,
    ...(bazaarExtension !== undefined ? { extensions: bazaarExtension } : {}),
  };

  const protocol = await runProtocol({
    opts: middlewareOpts,
    resourceUrl: args.resourceUrl,
    paymentHeader: args.paymentHeader,
    idempotencyKey: args.idempotencyKey,
  });

  if (protocol.kind !== "accepted") {
    await logProxyRequest(deps.pool, {
      proxyConfigId: config.id,
      resourceKeyId: config.resourceKeyId,
      outcome: protocol.kind === "challenge" ? "challenge" : "settle_failed",
      errorCode:
        protocol.kind === "rejected" ? protocol.reason ?? null : null,
      ipHash,
    });
    return {
      status: protocol.status,
      body: protocol.body,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "payment-required": encodeHeaderJson(protocol.body),
      },
      outcome: protocol.kind === "challenge" ? "challenge" : "settle_failed",
    };
  }

  // Settled — dispatch to internal handler (first-party service) or
  // forward to the upstream HTTP API (reseller flow).
  const receipt = protocol.receipt;

  if (config.internalHandler) {
    const handler = getInternalHandler(config.internalHandler);
    if (!handler) {
      deps.logger?.error?.(
        `proxy: unknown internal_handler=${config.internalHandler} config=${config.id}`,
      );
      await logProxyRequest(deps.pool, {
        proxyConfigId: config.id,
        resourceKeyId: config.resourceKeyId,
        outcome: "invalid_config",
        errorCode: `unknown_internal_handler:${config.internalHandler}`,
        network: receipt.network,
        amountAtomic: receipt.amount,
        txHash: receipt.txHash,
        ipHash,
      });
      return {
        status: 503,
        body: { error: "proxy_misconfigured" },
        headers: { "content-type": "application/json" },
        outcome: "invalid_config",
      };
    }
    const startedAtInternal = Date.now();
    let handlerResult;
    try {
      handlerResult = await handler({
        body: args.body,
        method: args.method.toUpperCase(),
        fetchImpl,
      });
    } catch (err) {
      const latencyMsErr = Date.now() - startedAtInternal;
      deps.logger?.error?.(
        `proxy: internal handler threw handler=${config.internalHandler} config=${config.id}`,
        err,
      );
      await logProxyRequest(deps.pool, {
        proxyConfigId: config.id,
        resourceKeyId: config.resourceKeyId,
        outcome: "upstream_error",
        network: receipt.network,
        amountAtomic: receipt.amount,
        txHash: receipt.txHash,
        upstreamLatencyMs: latencyMsErr,
        errorCode: "internal_handler_threw",
        ipHash,
      });
      return {
        status: 500,
        body: { error: "internal_handler_error" },
        headers: { "content-type": "application/json" },
        outcome: "upstream_error",
      };
    }
    const latencyMsInternal = Date.now() - startedAtInternal;
    await recordSettledWithInboundLink(deps, config, receipt, args, {
      upstreamStatus: handlerResult.status,
      upstreamLatencyMs: latencyMsInternal,
      ipHash,
    });
    const paymentResponseInternal = encodeHeaderJson({
      success: true,
      transaction: receipt.txHash ?? "",
      network: receipt.network,
      payer: receipt.payer,
      amount: receipt.amount,
    });
    return {
      status: handlerResult.status,
      body: handlerResult.body,
      headers: {
        "content-type": "application/json",
        "payment-response": paymentResponseInternal,
        "x-payment-response": paymentResponseInternal,
        "access-control-expose-headers":
          "PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
      },
      outcome: "settled",
    };
  }

  let forwardHeaders: Record<string, string>;
  try {
    forwardHeaders = config.forwardHeadersEncrypted
      ? decryptHeaders(config.forwardHeadersEncrypted, deps.masterKey)
      : {};
  } catch (err) {
    deps.logger?.error?.(
      `proxy: header decryption failed for config=${config.id}`,
      err,
    );
    await logProxyRequest(deps.pool, {
      proxyConfigId: config.id,
      resourceKeyId: config.resourceKeyId,
      outcome: "invalid_config",
      errorCode: "decrypt_failed",
      facilitatorPaymentId: null,
      network: receipt.network,
      amountAtomic: receipt.amount,
      txHash: receipt.txHash,
      ipHash,
    });
    return {
      status: 500,
      body: { error: "proxy_misconfigured" },
      headers: { "content-type": "application/json" },
      outcome: "invalid_config",
    };
  }

  const upstreamHeaders = mergeUpstreamHeaders(
    args.incomingHeaders,
    forwardHeaders,
  );

  const startedAt = Date.now();
  let upstreamRes: Response;
  let upstreamBody: Buffer;

  if (config.upstreamX402Enabled) {
    if (!deps.upstreamX402Client || !deps.upstreamServiceAddresses) {
      deps.logger?.error?.(
        `proxy: upstream_x402_enabled=true but no service client wired ` +
          `(config=${config.id}). Treat as misconfigured.`,
      );
      await logProxyRequest(deps.pool, {
        proxyConfigId: config.id,
        resourceKeyId: config.resourceKeyId,
        outcome: "invalid_config",
        errorCode: "no_service_client",
        network: receipt.network,
        amountAtomic: receipt.amount,
        txHash: receipt.txHash,
        ipHash,
      });
      return {
        status: 503,
        body: { error: "proxy_misconfigured" },
        headers: { "content-type": "application/json" },
        outcome: "invalid_config",
      };
    }
    if (!config.upstreamX402Network || !config.upstreamSignerWallet) {
      deps.logger?.error?.(
        `proxy: upstream_x402_enabled but network/signer missing config=${config.id}`,
      );
      await logProxyRequest(deps.pool, {
        proxyConfigId: config.id,
        resourceKeyId: config.resourceKeyId,
        outcome: "invalid_config",
        errorCode: "upstream_x402_incomplete",
        ipHash,
      });
      return {
        status: 503,
        body: { error: "proxy_misconfigured" },
        headers: { "content-type": "application/json" },
        outcome: "invalid_config",
      };
    }
    // Two-phase recorder so an on-chain spend by the upstream's
    // facilitator is captured even when the retry returns non-200 or
    // never returns. The hook is non-fatal end-to-end: any DB error
    // inside start/finish is logged but does not propagate, so a
    // logging outage cannot mask a successful upstream response.
    const recorder: OutboundRecorder = {
      start: (input) =>
        startOutboundUpstreamPayment(deps.pool, {
          resourceKeyId: config.resourceKeyId,
          ...input,
        }),
      finish: (id, outcome) =>
        finishOutboundUpstreamPayment(deps.pool, id, outcome),
    };
    // Refund-pending recorder — invoked when the upstream call fails
    // AFTER we've signed and sent the X-PAYMENT retry. The buyer has
    // paid us already; the operator drains `refunds_pending` to make
    // them whole. Best-effort: a DB outage here MUST NOT prevent
    // returning the upstream error to the buyer.
    const refundPendingRecorder: RefundPendingRecorder = {
      record: async (info) => {
        await recordRefundPending(deps.pool, {
          proxyConfigId: config.id,
          resourceKeyId: config.resourceKeyId,
          buyerAddress: receipt.payer,
          buyerNetwork: receipt.network,
          buyerAsset: receipt.asset,
          buyerAmountAtomic: receipt.amount,
          buyerTxHash: receipt.txHash,
          reason: info.reason,
          upstreamStatus: info.upstreamStatus,
          upstreamErrorSnippet: info.upstreamErrorSnippet,
        });
      },
    };
    const upstreamResult = await callUpstreamWithX402(
      {
        upstreamUrl: config.originalUrl,
        method: config.originalMethod,
        headers: upstreamHeaders,
        body: args.body,
        requiredNetwork: config.upstreamX402Network,
        maxPriceHumanUsdc: config.upstreamX402MaxPrice,
        signerNamespace: config.upstreamSignerWallet,
      },
      {
        client: deps.upstreamX402Client,
        addresses: deps.upstreamServiceAddresses,
        fetchImpl,
        recorder,
        refundPendingRecorder,
        ...(deps.logger ? { logger: deps.logger } : {}),
      },
    );
    if (upstreamResult.kind === "error") {
      const latencyMs = Date.now() - startedAt;
      deps.logger?.warn?.(
        `proxy: upstream-x402 failed config=${config.id} reason=${upstreamResult.reason} msg=${upstreamResult.message}`,
      );
      await logProxyRequest(deps.pool, {
        proxyConfigId: config.id,
        resourceKeyId: config.resourceKeyId,
        outcome: "upstream_error",
        network: receipt.network,
        amountAtomic: receipt.amount,
        txHash: receipt.txHash,
        upstreamStatus: upstreamResult.upstreamStatus ?? null,
        upstreamLatencyMs: latencyMs,
        errorCode: `upstream_x402_${upstreamResult.reason}`,
        ipHash,
      });
      return {
        status: 503,
        body: { error: "upstream_unreachable", reason: upstreamResult.reason },
        headers: { "content-type": "application/json", "retry-after": "30" },
        outcome: "upstream_error",
      };
    }
    upstreamRes = upstreamResult.response;
    upstreamBody = upstreamResult.bodyBuffer;
    if (upstreamResult.kind === "paid") {
      // facilitator_payments row is now written inside
      // callUpstreamWithX402 via the recorder hook above (two-phase
      // pending→settled). Keep the success log line for operators
      // grepping journalctl for "upstream-x402 paid".
      deps.logger?.info?.(
        `proxy: upstream-x402 paid config=${config.id} ` +
          `network=${upstreamResult.payment.network} ` +
          `amount=${upstreamResult.payment.amountAtomic} ` +
          `recipient=${upstreamResult.payment.recipient} ` +
          `tx=${upstreamResult.payment.txHash ?? "(none)"}`,
      );
    }
  } else {
    try {
      upstreamRes = await fetchImpl(config.originalUrl, {
        method: config.originalMethod,
        headers: upstreamHeaders,
        body: args.body && args.body.length > 0 ? args.body : undefined,
      });
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      deps.logger?.warn?.(
        `proxy: upstream fetch failed config=${config.id} url=${config.originalUrl}`,
        err,
      );
      await logProxyRequest(deps.pool, {
        proxyConfigId: config.id,
        resourceKeyId: config.resourceKeyId,
        outcome: "upstream_error",
        network: receipt.network,
        amountAtomic: receipt.amount,
        txHash: receipt.txHash,
        upstreamLatencyMs: latencyMs,
        errorCode: "fetch_error",
        ipHash,
      });
      return {
        status: 502,
        body: { error: "upstream_unreachable" },
        headers: { "content-type": "application/json" },
        outcome: "upstream_error",
      };
    }
    upstreamBody = Buffer.from(await upstreamRes.arrayBuffer());
  }

  const latencyMs = Date.now() - startedAt;

  await recordSettledWithInboundLink(deps, config, receipt, args, {
    upstreamStatus: upstreamRes.status,
    upstreamLatencyMs: latencyMs,
    ipHash,
  });

  const respHeaders = stripHopByHop(upstreamRes.headers);
  const paymentResponse = encodeHeaderJson({
    success: true,
    transaction: receipt.txHash ?? "",
    network: receipt.network,
    payer: receipt.payer,
    amount: receipt.amount,
  });
  respHeaders["payment-response"] = paymentResponse;
  respHeaders["x-payment-response"] = paymentResponse;
  respHeaders["access-control-expose-headers"] =
    "PAYMENT-RESPONSE, X-PAYMENT-RESPONSE";

  return {
    status: upstreamRes.status,
    body: upstreamBody,
    headers: respHeaders,
    outcome: "settled",
  };
}

// Per-VM `scheme` declaration the proxy emits in 402 challenges.
// Cosmos pays through an authz Exec dispatched by the facilitator's
// grantee — the only x402 scheme cosmos-pay routes today is
// `exact_cosmos_authz`, and both the buyer SDK's Cosmos signer and the
// facilitator's routing table reject any other value. EVM, Solana,
// and TRON all use the plain `exact` scheme.
//
// `AcceptedPayment.scheme` from `@suverselabs/x402-server` is typed as
// the literal `"exact"` in the published v1 (the middleware itself
// never branches on scheme; it just round-trips the string into the
// 402 body and the facilitator routes on the resulting tuple). Cast
// the per-VM values to that narrower type at the boundary instead of
// widening the published library — the cast is invisible at runtime
// and surfaces the constraint in one place if we ever bump the lib's
// scheme union.
const SCHEME_BY_NAMESPACE: Record<
  "evm" | "solana" | "cosmos" | "tron",
  AcceptedPayment["scheme"]
> = {
  evm: "exact",
  solana: "exact",
  cosmos: "exact_cosmos_authz" as AcceptedPayment["scheme"],
  tron: "exact",
};

function buildAcceptedPayments(config: ProxyConfigRow): AcceptedPayment[] {
  const out: AcceptedPayment[] = [];
  for (const caip2 of config.acceptedNetworks) {
    const entry = lookupNetwork(caip2);
    if (!entry) continue;
    const payTo =
      entry.namespace === "evm"
        ? config.payToEvm
        : entry.namespace === "solana"
        ? config.payToSolana
        : entry.namespace === "cosmos"
        ? config.payToCosmos
        : entry.namespace === "tron"
        ? config.payToTron
        : null;
    if (!payTo) continue;
    out.push({
      scheme: SCHEME_BY_NAMESPACE[entry.namespace],
      network: entry.caip2,
      asset: entry.usdcAsset,
      payTo,
      maxAmountRequired: config.priceAtomic,
    });
  }
  return out;
}

function mergeUpstreamHeaders(
  incoming: Record<string, string>,
  injected: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  // Injected (seller-provided) headers win — that's the whole point
  // of the proxy: stamp the upstream API key on outgoing requests.
  for (const [name, value] of Object.entries(injected)) {
    out[name] = value;
  }
  return out;
}

// Response-only headers the proxy must NOT forward to the buyer. The
// upstream Response's body was already decompressed by undici when we
// called `arrayBuffer()`, so the `Content-Encoding` it advertised is
// no longer accurate. Leaving it on triggers the client to try a
// second round of gunzip on plain bytes — undici throws "terminated".
// Fastify will recompute `Content-Length` from the Buffer we send, so
// we drop the upstream's value to keep the two in sync.
const RESPONSE_STRIP = new Set(["content-encoding", "content-length"]);

function stripHopByHop(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || RESPONSE_STRIP.has(lower)) return;
    out[name] = value;
  });
  return out;
}

function encodeHeaderJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

/**
 * Pick the seller's pay_to address matching the network the buyer
 * actually paid on. Mirrors the namespace switch in
 * `buildAcceptedPayments`; only invoked from settled paths where the
 * relevant pay_to was non-null at challenge time, so the empty-string
 * default below is only ever taken on misconfigured rows (defensive).
 */
function recipientForNetwork(
  config: ProxyConfigRow,
  network: string,
): string {
  const entry = lookupNetwork(network);
  if (!entry) return "";
  switch (entry.namespace) {
    case "evm":
      return config.payToEvm ?? "";
    case "solana":
      return config.payToSolana ?? "";
    case "cosmos":
      return config.payToCosmos ?? "";
    case "tron":
      return config.payToTron ?? "";
    default:
      return "";
  }
}

/**
 * Deterministic per-payment id used as the seller-side
 * `facilitator_payments.idempotency_key` when the proxy has to write
 * a fallback inbound row (approach B). The buyer's
 * `Idempotency-Key` header wins when supplied (the natural retry
 * contract); otherwise a fingerprint of receipt fields keeps
 * re-issues of the same call landing on the same row via the unique
 * index on (resource_key_id, idempotency_key).
 */
function inboundFallbackIdempotencyKey(
  buyerIdemKey: string | undefined,
  receipt: { payer: string; network: string; amount: string; txHash: string | null },
): string {
  if (buyerIdemKey && buyerIdemKey.length > 0) return buyerIdemKey;
  const seed = receipt.txHash
    ? `tx:${receipt.txHash}`
    : `payer:${receipt.payer}|net:${receipt.network}|amt:${receipt.amount}`;
  return createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 32);
}

/**
 * Settled-path sink for inbound x402 payments. Tries Approach A first
 * (look up the existing `facilitator_payments` row the gateway wrote,
 * join on tx_hash + network), then Approach B fallback (write a fresh
 * inbound row OWNED by the seller's resource_key) when A returns
 * nothing — typically the no-txHash case, occasionally the race
 * where the proxy is reading before the gateway's commit is visible.
 *
 * Either way, `proxy_request_logs.facilitator_payment_id` is filled
 * in so the dashboard can answer "who paid me?" with a single join.
 *
 * Best-effort end-to-end: any DB error inside the resolver falls back
 * to a plain `logProxyRequest` without the fp link. The buyer already
 * paid on-chain — never let bookkeeping mask the success.
 */
async function recordSettledWithInboundLink(
  deps: HandleDeps,
  config: ProxyConfigRow,
  receipt: {
    payer: string;
    network: string;
    asset: string;
    amount: string;
    txHash: string | null;
  },
  args: HandleArgs,
  log: {
    upstreamStatus: number;
    upstreamLatencyMs: number;
    ipHash: string | null;
  },
): Promise<void> {
  let fpId: string | null = null;
  try {
    if (receipt.txHash !== null) {
      fpId = await findInboundFacilitatorPaymentByTxHash(
        deps.pool,
        receipt.txHash,
        receipt.network,
      );
    }
    if (fpId === null) {
      const idem = inboundFallbackIdempotencyKey(args.idempotencyKey, receipt);
      fpId = await createInboundFacilitatorPaymentFallback(deps.pool, {
        resourceKeyId: config.resourceKeyId,
        idempotencyKey: idem,
        network: receipt.network,
        asset: receipt.asset,
        scheme: SCHEME_BY_NAMESPACE[lookupNetwork(receipt.network)?.namespace ?? "evm"],
        amountAtomic: receipt.amount,
        payer: receipt.payer,
        recipient: recipientForNetwork(config, receipt.network),
        txHash: receipt.txHash,
      });
    }
  } catch (err) {
    deps.logger?.warn?.(
      `proxy: inbound fp link resolve failed config=${config.id} ` +
        `network=${receipt.network} payer=${receipt.payer} ` +
        `tx=${receipt.txHash ?? "(none)"}`,
      err,
    );
    fpId = null;
  }

  try {
    await logProxyRequest(deps.pool, {
      proxyConfigId: config.id,
      resourceKeyId: config.resourceKeyId,
      outcome: "settled",
      facilitatorPaymentId: fpId,
      network: receipt.network,
      amountAtomic: receipt.amount,
      txHash: receipt.txHash,
      upstreamStatus: log.upstreamStatus,
      upstreamLatencyMs: log.upstreamLatencyMs,
      ipHash: log.ipHash,
    });
  } catch (err) {
    deps.logger?.error?.(
      `proxy: logProxyRequest failed for settled row config=${config.id} ` +
        `tx=${receipt.txHash ?? "(none)"}`,
      err,
    );
  }
}
