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
import { decryptHeaders } from "./crypto.js";
import { lookupNetwork } from "./networks.js";
import {
  logProxyRequest,
  type ProxyConfigRow,
  type ProxyConfigStore,
  type ProxyOutcome,
} from "./store.js";
import { checkUpstreamHealth } from "./upstream-health.js";

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
  const noPaymentHeader =
    args.paymentHeader === undefined || args.paymentHeader.trim() === "";
  if (noPaymentHeader) {
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

  const middlewareOpts: MiddlewareOptions = {
    apiKey: deps.facilitatorApiKey,
    facilitator: deps.facilitatorUrl,
    acceptedPayments: accepted,
    description: config.description ?? config.displayName ?? undefined,
    x402Version: 2,
    settle: true,
    fetchImpl,
    logger: deps.logger,
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

  // Settled — forward to upstream.
  const receipt = protocol.receipt;
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

  const latencyMs = Date.now() - startedAt;
  const upstreamBody = Buffer.from(await upstreamRes.arrayBuffer());

  await logProxyRequest(deps.pool, {
    proxyConfigId: config.id,
    resourceKeyId: config.resourceKeyId,
    outcome: "settled",
    network: receipt.network,
    amountAtomic: receipt.amount,
    txHash: receipt.txHash,
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
      scheme: "exact",
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
