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
  getInternalHandlerPreflight,
  getInternalHandlerValidator,
} from "./handlers/registry.js";
import {
  BRANDING_HEADER_NAMES,
  type BrandingApplicator,
} from "./middleware/response-branding.js";
import {
  isMppAuthorization,
  type MppChallengeInput,
  type MppRail,
} from "./mpp.js";
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
  /**
   * Response-branding applicator. When supplied, the proxy adds
   * X-Suverse-* headers to settled-200 responses so AI buyers can
   * discover the rest of the catalog without payload modification.
   * Failure during branding is swallowed — the settled response is
   * never blocked by a branding bug.
   */
  branding?: BrandingApplicator;
  /**
   * MPP/Tempo rail (Task 39a-rescoped). Optional — absent means the
   * proxy is x402-only, exactly as before. Present, it only applies
   * to rows with `mpp_tempo_enabled = true` AND a non-null
   * `pay_to_evm` (the Tempo recipient): those rows' 402s grow a
   * `WWW-Authenticate: Payment` challenge and `Authorization:
   * Payment` credentials are verified + settled on Tempo instead of
   * going through the x402 facilitator.
   */
  mppRail?: MppRail;
}

/** Result returned to the Fastify adapter — flattened for clarity. */
export async function handle(
  args: HandleArgs,
  deps: HandleDeps,
): Promise<HandleResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const ipHash = hashIp(args.clientIp);
  // Capture inbound User-Agent for crawler attribution. Cap at 1024
  // chars so a misbehaving client can't blow up TEXT storage with a
  // many-KB UA. Empty string normalises to null.
  const rawUa = args.incomingHeaders["user-agent"];
  const userAgent: string | null =
    typeof rawUa === "string" && rawUa.length > 0
      ? rawUa.slice(0, 1024)
      : null;

  // Parsed request body captured for forensics (migration 035). Only
  // /v1/data/* POST traffic is logged — the legacy /v1/proxy routes
  // forward arbitrary seller payloads we have no business retaining.
  const loggedBody = requestBodyForLog(args);

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
      userAgent,
      requestBody: loggedBody,
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
          userAgent,
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
      userAgent,
      requestBody: loggedBody,
    });
    return {
      status: 503,
      body: { error: "endpoint_misconfigured" },
      headers: { "content-type": "application/json" },
      outcome: "invalid_config",
    };
  }

  // MPP/Tempo rail gating (Task 39a-rescoped). The rail is active
  // for THIS request only when every layer agrees: the process has a
  // configured rail (deps.mppRail), the row opted in (migration 036
  // flag), and the row has an EVM payout address to reuse as the
  // Tempo recipient. An `Authorization: Payment …` header on a
  // non-gated row is ignored exactly as Authorization always was.
  const mppRail =
    deps.mppRail && config.mppTempoEnabled && config.payToEvm !== null
      ? deps.mppRail
      : undefined;
  const rawAuthorization = args.incomingHeaders["authorization"];
  const mppAuthorization =
    mppRail !== undefined && isMppAuthorization(rawAuthorization)
      ? rawAuthorization
      : undefined;
  const mppInput: MppChallengeInput | undefined =
    mppRail !== undefined
      ? {
          amountAtomic: config.priceAtomic,
          recipient: config.payToEvm as string,
          // Scope binds the credential to this route — a credential
          // bought for endpoint A fails verification on endpoint B.
          scope: config.publicSlug ?? config.endpointSlug,
          description:
            config.displayName ??
            config.publicSlug ??
            config.endpointSlug,
        }
      : undefined;

  // Pre-charge upstream health probe. Only runs when the buyer
  // hasn't sent payment yet — i.e. the request that would otherwise
  // get a 402 challenge. If the buyer is already paying, we let
  // runProtocol + the upstream call play out so they see real
  // upstream errors (and the existing `outcome: "upstream_error"`
  // logging) rather than getting blocked by a probe. An MPP
  // credential counts as payment for the same reason.
  //
  // Internal handlers have no external upstream to probe — skip.
  const noPaymentHeader =
    (args.paymentHeader === undefined || args.paymentHeader.trim() === "") &&
    mppAuthorization === undefined;
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
        userAgent,
        requestBody: loggedBody,
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

  // Pre-settlement preflight for fail-closed internal handlers. Runs
  // only when the buyer actually sent payment (a challenge request
  // never settles, so there is nothing to protect) and the handler
  // registered a preflight. If the handler's critical sources are
  // down we return the preflight's response BEFORE runProtocol() —
  // the buyer is never charged for a product we cannot produce. On
  // success the preflight's data is threaded into the handler call
  // below so critical sources aren't computed twice.
  let preflightData: unknown;
  if (!noPaymentHeader && config.internalHandler) {
    const preflight = getInternalHandlerPreflight(config.internalHandler);
    if (preflight) {
      const startedPreflight = Date.now();
      let pf: Awaited<ReturnType<typeof preflight>>;
      try {
        pf = await preflight({
          body: args.body,
          method: args.method.toUpperCase(),
          fetchImpl,
          db: deps.pool,
        });
      } catch (err) {
        deps.logger?.error?.(
          `proxy: preflight threw handler=${config.internalHandler} config=${config.id}`,
          err,
        );
        pf = {
          proceed: false,
          status: 503,
          body: { error: "preflight_failed", retryable: true },
        };
      }
      if (!pf.proceed) {
        await logProxyRequest(deps.pool, {
          proxyConfigId: config.id,
          resourceKeyId: config.resourceKeyId,
          outcome: "upstream_error",
          upstreamStatus: pf.status,
          upstreamLatencyMs: Date.now() - startedPreflight,
          errorCode: "preflight_critical_source_down",
          ipHash,
          userAgent,
          requestBody: loggedBody,
        });
        return {
          status: pf.status,
          body: pf.body,
          headers: {
            "content-type": "application/json",
            "retry-after": "30",
          },
          outcome: "upstream_error",
        };
      }
      preflightData = pf.data;
    }
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

  // Description forwarded to CDP via paymentRequirements.description.
  // CDP caps the field at ~320 ASCII chars (silently truncates the
  // tail), so prefer a hand-tuned keyword-dense `description_bazaar`
  // when the seller has populated one. Fall back to slicing the
  // long-form `description` to 320 so the truncation we ship matches
  // a sentence boundary as far as possible, rather than whatever CDP
  // would have cut to.
  const cdpDescription =
    config.descriptionBazaar ??
    (config.description !== null && config.description.length > 320
      ? config.description.slice(0, 320)
      : (config.description ?? config.displayName ?? undefined));

  const middlewareOpts: MiddlewareOptions = {
    apiKey: deps.facilitatorApiKey,
    facilitator: deps.facilitatorUrl,
    acceptedPayments: accepted,
    description: cdpDescription,
    x402Version: 2,
    settle: true,
    fetchImpl,
    logger: deps.logger,
    ...(bazaarExtension !== undefined ? { extensions: bazaarExtension } : {}),
  };

  // Settle. Two mutually exclusive rails:
  //   - MPP: the buyer answered our `WWW-Authenticate: Payment`
  //     challenge. Verify + settle on Tempo ourselves — the x402
  //     facilitator is not involved.
  //   - x402 (default): runProtocol() against the facilitator, which
  //     also produces the 402 challenge when no payment was sent.
  // Both paths converge on the same `receipt` shape so the dispatch
  // and bookkeeping below stay rail-agnostic.
  let receipt: {
    payer: string;
    network: string;
    asset: string;
    amount: string;
    txHash: string | null;
  };
  let settledViaMpp = false;
  let mppReceiptHeader: string | undefined;

  if (mppRail !== undefined && mppInput !== undefined && mppAuthorization !== undefined) {
    const settle = await mppRail.verifyAndSettle(mppAuthorization, mppInput);
    if (!settle.ok) {
      deps.logger?.warn?.(
        `proxy: mpp settle failed config=${config.id} code=${settle.errorCode} msg=${settle.message}`,
      );
      await logProxyRequest(deps.pool, {
        proxyConfigId: config.id,
        resourceKeyId: config.resourceKeyId,
        outcome: "settle_failed",
        errorCode: settle.errorCode,
        network: mppRail.network,
        ipHash,
        userAgent,
        requestBody: loggedBody,
      });
      // Re-challenge: a fresh MPP challenge so a well-behaved buyer
      // can retry (the failed credential's challenge may simply have
      // expired). The x402 body is omitted on purpose — this buyer
      // already chose the MPP rail.
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "cache-control": "no-store",
      };
      const retryChallenge = await tryMppChallengeHeader(
        mppRail,
        mppInput,
        deps.logger,
      );
      if (retryChallenge !== undefined) {
        headers["www-authenticate"] = retryChallenge;
      }
      return {
        status: 402,
        body: {
          error: "mpp_payment_failed",
          code: settle.errorCode,
          message: settle.message,
        },
        headers,
        outcome: "settle_failed",
      };
    }
    receipt = {
      payer: settle.payer,
      network: mppRail.network,
      asset: mppRail.asset,
      amount: config.priceAtomic,
      txHash: settle.txHash.length > 0 ? settle.txHash : null,
    };
    settledViaMpp = true;
    mppReceiptHeader = settle.receiptHeader;
  } else {
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
        userAgent,
        requestBody: loggedBody,
      });
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "cache-control": "no-store",
        "payment-required": encodeHeaderJson(protocol.body),
      };
      // Additive MPP challenge: MPP lives entirely in headers, so
      // emitting it next to the x402 JSON body is non-breaking for
      // x402 buyers (and invisible to CDP's crawler). Generation
      // failure is logged and swallowed — never break the x402 402.
      if (
        protocol.kind === "challenge" &&
        mppRail !== undefined &&
        mppInput !== undefined
      ) {
        const mppChallenge = await tryMppChallengeHeader(
          mppRail,
          mppInput,
          deps.logger,
        );
        if (mppChallenge !== undefined) {
          headers["www-authenticate"] = mppChallenge;
        }
      }
      return {
        status: protocol.status,
        body: protocol.body,
        headers,
        outcome: protocol.kind === "challenge" ? "challenge" : "settle_failed",
      };
    }
    receipt = protocol.receipt;
  }

  // Settled — dispatch to internal handler (first-party service) or
  // forward to the upstream HTTP API (reseller flow).

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
        userAgent,
        requestBody: loggedBody,
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
        db: deps.pool,
        ...(preflightData !== undefined ? { preflightData } : {}),
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
        userAgent,
        requestBody: loggedBody,
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
      userAgent,
      requestBody: loggedBody,
      settledViaMpp,
    });
    const paymentResponseInternal = encodeHeaderJson({
      success: true,
      transaction: receipt.txHash ?? "",
      network: receipt.network,
      payer: receipt.payer,
      amount: receipt.amount,
    });
    const brandingInternal = await tryBranding(deps, {
      slug: config.publicSlug ?? config.endpointSlug,
      acceptedNetworks: config.acceptedNetworks,
      displayName: config.displayName,
      status: handlerResult.status,
      isSwapEndpoint: isSwapEndpointConfig(config),
      rotationSeed: receipt.txHash ?? args.idempotencyKey ?? null,
    });
    return {
      status: handlerResult.status,
      body: handlerResult.body,
      headers: {
        "content-type": "application/json",
        "payment-response": paymentResponseInternal,
        "x-payment-response": paymentResponseInternal,
        ...(mppReceiptHeader !== undefined
          ? { "payment-receipt": mppReceiptHeader }
          : {}),
        "access-control-expose-headers": brandingExposeHeader(brandingInternal),
        ...brandingInternal,
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
      userAgent,
      requestBody: loggedBody,
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
        userAgent,
        requestBody: loggedBody,
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
        userAgent,
        requestBody: loggedBody,
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
        userAgent,
        requestBody: loggedBody,
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
        userAgent,
        requestBody: loggedBody,
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
    userAgent,
    requestBody: loggedBody,
    settledViaMpp,
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
  if (mppReceiptHeader !== undefined) {
    respHeaders["payment-receipt"] = mppReceiptHeader;
  }
  const brandingUpstream = await tryBranding(deps, {
    slug: config.publicSlug ?? config.endpointSlug,
    acceptedNetworks: config.acceptedNetworks,
    displayName: config.displayName,
    status: upstreamRes.status,
    isSwapEndpoint: isSwapEndpointConfig(config),
    rotationSeed: receipt.txHash ?? args.idempotencyKey ?? null,
  });
  for (const [name, value] of Object.entries(brandingUpstream)) {
    respHeaders[name] = value;
  }
  respHeaders["access-control-expose-headers"] =
    brandingExposeHeader(brandingUpstream);

  return {
    status: upstreamRes.status,
    body: upstreamBody,
    headers: respHeaders,
    outcome: "settled",
  };
}

/**
 * Returns the branding headers for the current request, or an empty
 * map if branding is not configured, skipped by env policy, or throws.
 * Branding MUST NOT block a settled response — we paid the upstream
 * and the buyer paid us; a misbehaving header policy can't change that.
 */
async function tryBranding(
  deps: HandleDeps,
  input: {
    slug: string;
    acceptedNetworks: string[];
    displayName: string | null;
    status: number;
    isSwapEndpoint: boolean;
    rotationSeed: string | null;
  },
): Promise<Record<string, string>> {
  if (!deps.branding) return {};
  try {
    const out = await deps.branding.apply(input);
    return out.headers;
  } catch (err) {
    deps.logger?.warn?.(
      `proxy: branding apply threw slug=${input.slug} — skipping`,
      err,
    );
    return {};
  }
}

/**
 * Builds the Access-Control-Expose-Headers value, always including
 * the payment-response pair (which existing buyer SDKs read), and
 * appending any branding headers actually emitted so browser-side
 * buyers can read them.
 */
function brandingExposeHeader(branding: Record<string, string>): string {
  const base = ["PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"];
  const present = BRANDING_HEADER_NAMES.filter((h) => branding[h] !== undefined);
  return [...base, ...present].join(", ");
}

/**
 * Builds the MPP `WWW-Authenticate` value, or undefined if challenge
 * generation throws. MPP is the additive rail — a bug in it must
 * never break the x402 402 (or the MPP error response) it rides on.
 */
async function tryMppChallengeHeader(
  rail: MppRail,
  input: MppChallengeInput,
  logger?: HandleDeps["logger"],
): Promise<string | undefined> {
  try {
    return await rail.challengeHeader(input);
  } catch (err) {
    logger?.warn?.(
      `proxy: mpp challenge generation failed scope=${input.scope} — omitting WWW-Authenticate`,
      err,
    );
    return undefined;
  }
}

/**
 * Detects swap endpoints by slug prefix or internal-handler key. Swap
 * responses already have their own structured shape and we'd recurse
 * if _related listed sibling swap routes — skip branding for these.
 */
function isSwapEndpointConfig(config: ProxyConfigRow): boolean {
  if (config.internalHandler && config.internalHandler.startsWith("swap-")) {
    return true;
  }
  if (config.endpointSlug.startsWith("swap-")) return true;
  if (config.publicSlug !== null && config.publicSlug.startsWith("swap-")) {
    return true;
  }
  return false;
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
 * Serialized-size cap for the forensic `request_body` column
 * (migration 035). 8 KiB covers every legitimate /v1/data payload we
 * have ever seen (the largest documented request body is well under
 * 1 KiB) while keeping a hostile 1 MiB POST from bloating the table.
 */
const MAX_LOGGED_BODY_BYTES = 8_192;

/**
 * Returns the parsed JSON body to persist in
 * `proxy_request_logs.request_body`, or null when nothing should be
 * logged. Scope is deliberately narrow: /v1/data/* POST traffic only
 * — that's first-party internal-handler territory where the body is
 * a query we authored the schema for. Legacy /v1/proxy/* routes
 * forward arbitrary third-party seller payloads which we have no
 * business retaining (the long-standing "no body logging" privacy
 * stance, see migration 010 comments).
 *
 * Oversize and unparseable bodies are recorded as small marker
 * objects rather than dropped — "agent POSTs 50KB of garbage" is
 * itself the forensic signal this column exists for.
 */
function requestBodyForLog(args: HandleArgs): unknown {
  if (args.method.toUpperCase() !== "POST") return null;
  let pathname: string;
  try {
    pathname = new URL(args.resourceUrl).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith("/v1/data/")) return null;
  if (!args.body || args.body.length === 0) return null;
  if (args.body.length > MAX_LOGGED_BODY_BYTES) {
    return { _oversize: true, byte_length: args.body.length };
  }
  try {
    return JSON.parse(args.body.toString("utf8")) as unknown;
  } catch {
    return { _unparseable: true, byte_length: args.body.length };
  }
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
    userAgent: string | null;
    requestBody: unknown;
    /**
     * MPP settles never touch `facilitator_payments` — there is no
     * facilitator in the loop and the table's scheme column speaks
     * x402. The settled `proxy_request_logs` row (network = Tempo
     * CAIP-2, tx_hash from the receipt) is the system of record.
     */
    settledViaMpp?: boolean;
  },
): Promise<void> {
  let fpId: string | null = null;
  if (log.settledViaMpp !== true) {
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
      userAgent: log.userAgent,
      requestBody: log.requestBody,
    });
  } catch (err) {
    deps.logger?.error?.(
      `proxy: logProxyRequest failed for settled row config=${config.id} ` +
        `tx=${receipt.txHash ?? "(none)"}`,
      err,
    );
  }
}
