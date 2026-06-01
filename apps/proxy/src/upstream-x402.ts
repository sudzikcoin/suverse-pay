/**
 * Upstream-x402 wrapping client.
 *
 * When seller_proxy_configs.upstream_x402_enabled is true, the proxy
 * itself is a buyer to the upstream API. The flow:
 *
 *   1. fetch(upstreamUrl) with the customer's headers + body — retried
 *      up to INITIAL_FETCH_RETRY_ATTEMPTS times on 5xx / network error
 *      with exponential backoff (200ms, 800ms). Pre-payment retries
 *      are safe because no money has moved yet.
 *   2. If 200 → pass straight back.
 *   3. If 5xx / network error after all retries → surface as
 *      upstream_unavailable.
 *   4. If 402 → parse the challenge, pick the accept whose `network`
 *      matches `upstream_x402_network`, check the quoted price against
 *      `upstream_x402_max_price`, sign with the service wallet for
 *      that namespace, retry with PAYMENT-SIGNATURE + X-PAYMENT.
 *   5. Return the retry response, the upstream tx hash, and the
 *      amount we paid so the caller can log to facilitator_payments.
 *
 * Anything other than 200 / 402 / 5xx (e.g. a 4xx that isn't 402)
 * gets passed through verbatim — the customer paid us already and
 * deserves the upstream's actual error.
 *
 * Post-payment failures (the X-PAYMENT retry returns non-200, aborts,
 * or network-errors) are NOT retried — our service wallet may already
 * have settled on-chain, so issuing the call again risks a double
 * spend. Instead the caller's `refundPendingRecorder` is invoked so
 * the operator can refund the buyer out-of-band. See refunds.ts and
 * migration 027.
 *
 * The service wallet is injected by the boot layer via the
 * `ServiceWallets` map: namespace ("solana", "evm", "cosmos", "tron")
 * → wallet credential in whatever shape the buyer SDK's signer for
 * that namespace expects. v1 only wires Solana; the shape is generic
 * so EVM / Cosmos slot in without an interface change.
 */

import { randomBytes } from "node:crypto";
import { SuverseClient } from "@suverselabs/x402-client";
import type {
  AcceptedRequirement,
  ChallengeBody,
  MultiChainWallets,
  PaymentEnvelope,
  ResourceInfo,
} from "@suverselabs/x402-client";

/** Wallets the proxy uses to act as a buyer to upstream 402s. */
export interface ServiceWallets {
  solana?: MultiChainWallets["solana"];
  evm?: MultiChainWallets["evm"];
  cosmos?: MultiChainWallets["cosmos"];
  tron?: MultiChainWallets["tron"];
}

/** Public addresses of the service wallets — used as `payer` in logs. */
export interface ServiceAddresses {
  solana?: string;
  evm?: string;
  cosmos?: string;
  tron?: string;
}

/**
 * Two-phase recorder hook. The handler implements this against
 * `facilitator_payments` so every signed-and-sent upstream call leaves
 * a row in the DB — even when the upstream's facilitator settles
 * on-chain but then returns a non-200 to us. Without the pre-insert
 * step, a retry_not_200 / timeout silently loses the on-chain
 * reference and we cannot reconcile our spend.
 *
 * `start` is called AFTER the envelope has been signed but BEFORE the
 * retry hits the wire. `finish` is called from every terminal branch
 * (200 OK, non-200, fetch threw / aborted) with the actual outcome.
 *
 * Both methods are wrapped in try/catch by the caller — a logging
 * failure must NEVER prevent the upstream call from completing, or
 * worse, mask a successful upstream response from the buyer.
 */
export interface OutboundRecorder {
  start(input: OutboundStartInput): Promise<string>;
  finish(id: string, outcome: OutboundFinishInput): Promise<void>;
}

export interface OutboundStartInput {
  idempotencyKey: string;
  network: string;
  asset: string;
  scheme: string;
  amountAtomic: string;
  payer: string;
  recipient: string;
}

export interface OutboundFinishInput {
  status: "settled" | "upstream_failed" | "upstream_timeout" | "network_error";
  txHash?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/**
 * Hook invoked when the upstream call fails AFTER we've signed and sent
 * the X-PAYMENT retry. The buyer paid us up front; the on-chain spend
 * by our service wallet may or may not have settled (we can't tell from
 * an HTTP 500 / timeout / network error). Either way the buyer isn't
 * getting the response, so the operator should refund them.
 *
 * The hook is fire-and-forget: any DB error is logged but does not
 * cascade into the upstream result. The buyer still gets the 502 the
 * caller is going to return; the missing refund row is a triage burden,
 * never a correctness break.
 */
export interface RefundPendingRecorder {
  record(input: {
    reason: "upstream_post_payment_500" | "upstream_post_payment_timeout" | "upstream_post_payment_network";
    upstreamStatus: number | null;
    upstreamErrorSnippet: string | null;
  }): Promise<void>;
}

/** Caller-tunable parameters for the pre-payment retry loop. */
const INITIAL_FETCH_RETRY_ATTEMPTS = 3; // 1 initial + 2 retries
const INITIAL_FETCH_RETRY_DELAYS_MS = [200, 800]; // index = retry # − 1

export interface UpstreamX402Deps {
  /** SuverseClient instance carrying the service wallets. */
  client: SuverseClient;
  /** Map namespace → service-wallet public address (for logging). */
  addresses: ServiceAddresses;
  fetchImpl: typeof fetch;
  logger?: Pick<Console, "info" | "warn" | "error">;
  /**
   * Optional two-phase outbound recorder. When provided, a 'pending'
   * row is written before the retry and updated to a terminal state
   * after — protects against silently losing on-chain spend when the
   * upstream's facilitator settles but the retry returns non-200.
   * Tests omit it; production wires it to `facilitator_payments`.
   */
  recorder?: OutboundRecorder;
  /**
   * Optional refund-pending recorder. Invoked when the upstream call
   * fails AFTER we've signed and sent the X-PAYMENT retry — the buyer
   * has paid us but won't get a response, so the operator should
   * refund. Tests usually omit it; production wires it to the
   * `refunds_pending` table via `apps/proxy/src/refunds.ts`.
   */
  refundPendingRecorder?: RefundPendingRecorder;
}

export interface UpstreamX402Args {
  upstreamUrl: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
  /** CAIP-2 the upstream MUST advertise — we refuse other accepts. */
  requiredNetwork: string;
  /** Defensive cap in human-readable USDC (e.g. "0.500000"). NULL = no cap. */
  maxPriceHumanUsdc: string | null;
  /** Namespace label picking which service wallet to use. */
  signerNamespace: string;
}

export type UpstreamX402Result =
  | {
      kind: "passthrough";
      response: Response;
      /** Body already drained to a Buffer for atomic logging + forwarding. */
      bodyBuffer: Buffer;
    }
  | {
      kind: "paid";
      response: Response;
      bodyBuffer: Buffer;
      /** What we paid the upstream. */
      payment: {
        network: string;
        scheme: string;
        asset: string;
        amountAtomic: string;
        payer: string;
        recipient: string;
        txHash: string | null;
      };
    }
  | {
      kind: "error";
      /** Maps onto the proxy's existing upstream_error logging path. */
      reason:
        | "network_error"
        | "upstream_5xx"
        | "missing_signer"
        | "no_matching_accept"
        | "price_cap_exceeded"
        | "sign_failed"
        | "retry_not_200"
        | "parse_challenge_failed";
      /** Optional HTTP status (e.g. 502 when upstream returned 5xx). */
      upstreamStatus?: number;
      message: string;
    };

/**
 * Try the upstream as a buyer-side x402 caller. Returns a discriminated
 * result the handler turns into HTTP. Never throws — every failure
 * mode maps to a structured `kind: "error"` so the handler stays
 * simple.
 */
export async function callUpstreamWithX402(
  args: UpstreamX402Args,
  deps: UpstreamX402Deps,
): Promise<UpstreamX402Result> {
  const initialInit: RequestInit = {
    method: args.method,
    headers: args.headers,
    body: args.body && args.body.length > 0 ? args.body : undefined,
  };

  deps.logger?.info?.(
    `upstream-x402: outbound url=${args.upstreamUrl} ` +
      `method=${args.method} ` +
      `bodyLen=${args.body?.length ?? 0} ` +
      `ct=${args.headers["content-type"] ?? "(none)"} ` +
      `headerKeys=${Object.keys(args.headers).join(",")}`,
  );

  // Pre-payment fetch with retry. Network error and 5xx are both
  // retryable here — the buyer has not paid the upstream yet, so a
  // retry can't double-spend. After all attempts are exhausted we
  // surface the original error semantics (network_error / upstream_5xx)
  // unchanged so the handler's logging path doesn't have to learn new
  // shapes.
  const fetchResult = await fetchInitialWithRetry(args.upstreamUrl, initialInit, deps);
  if (fetchResult.kind === "network_error") {
    return {
      kind: "error",
      reason: "network_error",
      message: fetchResult.message,
    };
  }
  if (fetchResult.kind === "upstream_5xx") {
    return {
      kind: "error",
      reason: "upstream_5xx",
      upstreamStatus: fetchResult.status,
      message: `upstream returned ${fetchResult.status} after ${fetchResult.attempts} attempts`,
    };
  }
  const first = fetchResult.response;

  // 200 — no payment was needed (e.g. cached endpoint, or first hit
  // before throttle). Forward as-is, the buyer still paid us, our
  // margin is 100%.
  if (first.status === 200) {
    const buf = Buffer.from(await first.arrayBuffer());
    return { kind: "passthrough", response: first, bodyBuffer: buf };
  }

  if (first.status !== 402) {
    // 4xx that isn't 402 — pass through verbatim. The buyer paid us
    // and deserves to see the upstream's actual error (e.g. 400 bad
    // signature on the user's body, 404 unknown route).
    const buf = Buffer.from(await first.arrayBuffer());
    deps.logger?.warn?.(
      `upstream-x402: non-402/non-200 from upstream url=${args.upstreamUrl} ` +
        `status=${first.status} bodyHead=${buf.slice(0, 400).toString("utf8")}`,
    );
    return { kind: "passthrough", response: first, bodyBuffer: buf };
  }

  // ----- 402 branch -----
  let challenge: ChallengeBody;
  try {
    challenge = await readChallenge(first, args.upstreamUrl);
  } catch (err) {
    return {
      kind: "error",
      reason: "parse_challenge_failed",
      message: (err as Error).message,
    };
  }

  const matching = challenge.accepts.find(
    (a) => a.network === args.requiredNetwork,
  );
  if (!matching) {
    const seen = challenge.accepts.map((a) => a.network).join(",") || "(none)";
    return {
      kind: "error",
      reason: "no_matching_accept",
      message: `upstream did not offer ${args.requiredNetwork}; offered: ${seen}`,
    };
  }

  if (args.maxPriceHumanUsdc !== null) {
    const cap = parseHumanUsdcToAtomic(args.maxPriceHumanUsdc, matching.asset);
    if (cap !== null && BigInt(matching.amount) > cap) {
      return {
        kind: "error",
        reason: "price_cap_exceeded",
        message: `upstream price ${matching.amount} > cap ${cap.toString()} atomic on ${matching.network}`,
      };
    }
  }

  const payerAddress = deps.addresses[args.signerNamespace as keyof ServiceAddresses];
  if (!payerAddress) {
    return {
      kind: "error",
      reason: "missing_signer",
      message: `no service wallet for namespace ${args.signerNamespace}`,
    };
  }

  let envelope: PaymentEnvelope;
  try {
    envelope = await deps.client.signRequirement(matching, {
      resource: challenge.resource.url,
    });
  } catch (err) {
    return {
      kind: "error",
      reason: "sign_failed",
      message: (err as Error).message,
    };
  }

  const headerValue = Buffer.from(JSON.stringify(envelope)).toString("base64");
  const retryHeaders: Record<string, string> = {
    ...args.headers,
    "PAYMENT-SIGNATURE": headerValue,
    "X-PAYMENT": headerValue,
  };

  // From here on every exit MUST land in `recorder.finish` (when
  // recorder is wired) so the on-chain spend can be reconciled later
  // even if the upstream returns an error or our fetch never
  // completes. The pre-insert is best-effort — if recording fails the
  // call still proceeds rather than losing the buyer's request.
  const outboundIdem = newOutboundIdempotencyKey();
  let recordedId: string | null = null;
  if (deps.recorder) {
    try {
      recordedId = await deps.recorder.start({
        idempotencyKey: outboundIdem,
        network: matching.network,
        asset: matching.asset,
        scheme: matching.scheme,
        amountAtomic: matching.amount,
        payer: payerAddress,
        recipient: matching.payTo,
      });
    } catch (err) {
      deps.logger?.warn?.(
        `upstream-x402: recorder.start failed (non-fatal) idem=${outboundIdem}`,
        err,
      );
    }
  }

  const finalize = async (outcome: OutboundFinishInput): Promise<void> => {
    if (!deps.recorder || recordedId === null) return;
    try {
      await deps.recorder.finish(recordedId, outcome);
    } catch (err) {
      deps.logger?.warn?.(
        `upstream-x402: recorder.finish failed (non-fatal) id=${recordedId} status=${outcome.status}`,
        err,
      );
    }
  };

  let retry: Response;
  try {
    retry = await deps.fetchImpl(args.upstreamUrl, {
      method: args.method,
      headers: retryHeaders,
      body: args.body && args.body.length > 0 ? args.body : undefined,
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const isAbort =
      (err as Error).name === "AbortError" ||
      /abort|timed?\s*out|timeout/i.test(message);
    await finalize({
      status: isAbort ? "upstream_timeout" : "network_error",
      errorCode: isAbort ? "retry_aborted" : "retry_network_error",
      errorMessage: message.slice(0, 500),
    });
    await recordRefundIfWired(deps, {
      reason: isAbort ? "upstream_post_payment_timeout" : "upstream_post_payment_network",
      upstreamStatus: null,
      upstreamErrorSnippet: message.slice(0, 500),
    });
    return {
      kind: "error",
      reason: "network_error",
      message,
    };
  }

  if (retry.status !== 200) {
    const errBody = Buffer.from(await retry.arrayBuffer())
      .slice(0, 600)
      .toString("utf8");
    deps.logger?.warn?.(
      `upstream-x402: retry non-200 status=${retry.status} body=${errBody}`,
    );
    // Try to extract a tx hash even on non-200 — some upstream
    // facilitators stamp PAYMENT-RESPONSE before the application
    // layer rejects the body, which means our money MAY have moved
    // on-chain. Capture whatever we can so reconciliation has
    // something to start from.
    await finalize({
      status: "upstream_failed",
      txHash: extractTxHash(retry),
      errorCode: `retry_http_${retry.status}`,
      errorMessage: errBody.slice(0, 500),
    });
    await recordRefundIfWired(deps, {
      reason: "upstream_post_payment_500",
      upstreamStatus: retry.status,
      upstreamErrorSnippet: errBody.slice(0, 500),
    });
    return {
      kind: "error",
      reason: "retry_not_200",
      upstreamStatus: retry.status,
      message: `upstream retry after payment returned HTTP ${retry.status}: ${errBody.slice(0, 200)}`,
    };
  }

  const buf = Buffer.from(await retry.arrayBuffer());
  const txHash = extractTxHash(retry);

  await finalize({
    status: "settled",
    txHash,
  });

  return {
    kind: "paid",
    response: retry,
    bodyBuffer: buf,
    payment: {
      network: matching.network,
      scheme: matching.scheme,
      asset: matching.asset,
      amountAtomic: matching.amount,
      payer: payerAddress,
      recipient: matching.payTo,
      txHash,
    },
  };
}

/** Random idempotency key for one outbound upstream-x402 call. */
export function newOutboundIdempotencyKey(): string {
  return `up_${randomBytes(12).toString("hex")}`;
}

type InitialFetchOutcome =
  | { kind: "response"; response: Response; attempts: number }
  | { kind: "upstream_5xx"; status: number; attempts: number }
  | { kind: "network_error"; message: string; attempts: number };

/**
 * Initial (pre-payment) upstream fetch with retry on 5xx / network
 * error. Retrying is safe here because the buyer has not paid the
 * upstream yet, so duplicate requests cannot double-spend. Up to
 * INITIAL_FETCH_RETRY_ATTEMPTS - 1 retries after the first attempt,
 * with exponential backoff drawn from INITIAL_FETCH_RETRY_DELAYS_MS.
 *
 * A non-5xx response (including 402, our happy path) returns
 * immediately on the first attempt that produced it. Only retries on
 * 500-599 status codes and on thrown fetch errors. 4xx-that-isn't-402
 * is handled by the caller as passthrough.
 */
async function fetchInitialWithRetry(
  url: string,
  init: RequestInit,
  deps: UpstreamX402Deps,
): Promise<InitialFetchOutcome> {
  let lastResponse: Response | null = null;
  let lastNetworkError: string | null = null;
  for (let attempt = 1; attempt <= INITIAL_FETCH_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const res = await deps.fetchImpl(url, init);
      if (res.status < 500) {
        return { kind: "response", response: res, attempts: attempt };
      }
      // 5xx — drain body so the next attempt's fetch is unblocked, and
      // remember the last response in case all attempts fail.
      lastResponse = res;
      // Drain previous body so a retry doesn't race on a half-read
      // stream from the previous attempt.
      try {
        await res.arrayBuffer();
      } catch {
        /* nothing to drain */
      }
      deps.logger?.warn?.(
        `upstream-x402: initial fetch attempt=${attempt}/${INITIAL_FETCH_RETRY_ATTEMPTS} ` +
          `status=${res.status} url=${url}`,
      );
    } catch (err) {
      lastNetworkError = (err as Error).message ?? String(err);
      deps.logger?.warn?.(
        `upstream-x402: initial fetch attempt=${attempt}/${INITIAL_FETCH_RETRY_ATTEMPTS} ` +
          `network_error url=${url} err=${lastNetworkError}`,
      );
    }
    // Last attempt — fall through to terminal branch below the loop.
    if (attempt < INITIAL_FETCH_RETRY_ATTEMPTS) {
      const delay = INITIAL_FETCH_RETRY_DELAYS_MS[attempt - 1] ?? 0;
      if (delay > 0) await sleep(delay);
    }
  }
  if (lastResponse !== null) {
    return {
      kind: "upstream_5xx",
      status: lastResponse.status,
      attempts: INITIAL_FETCH_RETRY_ATTEMPTS,
    };
  }
  return {
    kind: "network_error",
    message: lastNetworkError ?? "unknown fetch error",
    attempts: INITIAL_FETCH_RETRY_ATTEMPTS,
  };
}

/** Best-effort sleep for the retry backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort invocation of the refund-pending recorder. The buyer
 * already paid us, so we always need to return their error to them;
 * a DB failure recording the refund must NOT propagate.
 */
async function recordRefundIfWired(
  deps: UpstreamX402Deps,
  info: {
    reason: "upstream_post_payment_500" | "upstream_post_payment_timeout" | "upstream_post_payment_network";
    upstreamStatus: number | null;
    upstreamErrorSnippet: string | null;
  },
): Promise<void> {
  if (!deps.refundPendingRecorder) return;
  try {
    await deps.refundPendingRecorder.record(info);
  } catch (err) {
    deps.logger?.warn?.(
      `upstream-x402: refundPendingRecorder.record failed reason=${info.reason}`,
      err,
    );
  }
}

// -------------------------------------------------------------
// Helpers — challenge parsing + price math
// -------------------------------------------------------------

/**
 * Parse a 402 challenge body. The buyer SDK has its own parser, but
 * it's not exported separately and would couple us to v2-only shape.
 * We do a small permissive read that accepts both v1 (`accepts[].network`)
 * and v2 (`accepts[].network` + structured `resource`).
 */
async function readChallenge(
  response: Response,
  requestUrl: string,
): Promise<ChallengeBody> {
  let raw: unknown;
  const headerValue = response.headers.get("payment-required");
  if (headerValue) {
    try {
      raw = JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"));
    } catch {
      raw = null;
    }
  }
  if (!raw) {
    const text = await response.text();
    raw = JSON.parse(text);
  }
  const obj = raw as Record<string, unknown>;
  const acceptsRaw = (obj["accepts"] as unknown[] | undefined) ?? [];
  const accepts: AcceptedRequirement[] = acceptsRaw
    .map((a): AcceptedRequirement | null => {
      const r = a as Record<string, unknown>;
      const network = r["network"];
      const scheme = r["scheme"] ?? "exact";
      const asset = r["asset"];
      const payTo = r["payTo"];
      const amount = r["amount"] ?? r["maxAmountRequired"];
      if (
        typeof network !== "string" ||
        typeof asset !== "string" ||
        typeof payTo !== "string" ||
        typeof amount !== "string"
      ) {
        return null;
      }
      const out: AcceptedRequirement = {
        network,
        scheme: typeof scheme === "string" ? scheme : "exact",
        asset,
        payTo,
        amount,
        maxTimeoutSeconds:
          typeof r["maxTimeoutSeconds"] === "number"
            ? (r["maxTimeoutSeconds"] as number)
            : 60,
        ...(typeof r["description"] === "string"
          ? { description: r["description"] as string }
          : {}),
        ...(r["extra"] && typeof r["extra"] === "object"
          ? { extra: r["extra"] as Record<string, unknown> }
          : {}),
      };
      return out;
    })
    .filter((x): x is AcceptedRequirement => x !== null);

  const resource: ResourceInfo = (() => {
    const r = obj["resource"];
    if (typeof r === "string") return { url: r };
    if (r && typeof r === "object") {
      const rr = r as Record<string, unknown>;
      return {
        url: typeof rr["url"] === "string" ? (rr["url"] as string) : requestUrl,
        ...(typeof rr["description"] === "string"
          ? { description: rr["description"] as string }
          : {}),
        ...(typeof rr["mimeType"] === "string"
          ? { mimeType: rr["mimeType"] as string }
          : {}),
      };
    }
    return { url: requestUrl };
  })();

  const x402Version =
    obj["x402Version"] === 2 ? 2 : obj["x402Version"] === 1 ? 1 : 2;

  return {
    x402Version: x402Version as 1 | 2,
    resource,
    accepts,
    ...(typeof obj["description"] === "string"
      ? { description: obj["description"] as string }
      : {}),
    ...(typeof obj["error"] === "string"
      ? { error: obj["error"] as string }
      : {}),
  };
}

/**
 * Parse the base64 PAYMENT-RESPONSE header for the upstream tx hash.
 * Returns null when the upstream omits the header — a successful 200
 * is still recorded, just without an on-chain reference.
 */
function extractTxHash(response: Response): string | null {
  const headerValue =
    response.headers.get("payment-response") ??
    response.headers.get("x-payment-response");
  if (!headerValue) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(headerValue, "base64").toString("utf8"),
    ) as Record<string, unknown>;
    const tx = decoded["transaction"] ?? decoded["txHash"];
    return typeof tx === "string" && tx.length > 0 ? tx : null;
  } catch {
    return null;
  }
}

/**
 * Convert a human-readable USDC amount ("0.500000") to atomic units
 * based on the asset's decimals. v1 hardcodes the well-known 6-decimal
 * USDC mints across families; for unknown assets returns null which
 * disables the cap check (we'd rather pay than block on missing
 * decimals metadata for an upstream we just discovered).
 */
function parseHumanUsdcToAtomic(human: string, asset: string): bigint | null {
  // 6-decimal USDC across every facilitator we support today.
  const KNOWN_6_DECIMAL = new Set([
    // EVM USDC (Base, Arbitrum, Optimism, Polygon, etc. all use 6).
    // Match by suffix length only — every USDC contract on every chain
    // we accept uses 6 decimals.
    "0x".length + 40, // any EVM 0x address — fall through below
  ]);
  // EVM addresses 0x[40 hex]
  const isEvm = /^0x[0-9a-fA-F]{40}$/.test(asset);
  // Solana base58 mint (32-44 chars)
  const isSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(asset);
  // Cosmos / Noble denom uusdc
  const isCosmosDenom = asset === "uusdc";
  const isTronUsdc = /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(asset);
  const decimals = isEvm || isSolana || isCosmosDenom || isTronUsdc ? 6 : null;
  if (decimals === null) return null;
  void KNOWN_6_DECIMAL; // marker for future asset-specific overrides
  const trimmed = human.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const [intPart, fracPartRaw = ""] = trimmed.split(".");
  const fracPart = (fracPartRaw + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(intPart || "0") * BigInt(10) ** BigInt(decimals) + BigInt(fracPart || "0");
}
