import { createHash } from "node:crypto";
import { z } from "zod";
import {
  signPaymentPayload as signCosmosPaymentPayload,
  type PaymentRequirements as CosmosPaymentRequirements,
} from "@suverse-pay/signer-cosmos";
import { signPaymentPayload as signEvmPaymentPayload } from "@suverse-pay/signer-evm";
import type { Config } from "../config.js";
import type { GatewayClient } from "../gateway-client.js";
import { GatewayError } from "../gateway-client.js";
import { isCosmosNetwork, isEvmNetwork } from "../networks.js";
import type { Session, SessionStore } from "../session.js";
import { loadSession, safeErrorMessage, type ToolResult } from "./session-helper.js";

export const PayAndCallInputShape = {
  sessionId: z.string().uuid(),
  url: z.string().url(),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
} as const;
export const PayAndCallInput = z.object(PayAndCallInputShape);
export type PayAndCallInput = z.infer<typeof PayAndCallInput>;

export interface PayAndCallDeps {
  store: SessionStore;
  gateway: GatewayClient;
  config: Config;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override Date.now (tests, deterministic idempotency keys). */
  now?: () => number;
}

interface PaidEndpointResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface PayAndCallResult {
  /** "no_payment_required" when initial response wasn't 402. */
  status: "no_payment_required" | "settled";
  /** Gateway payment id, only when status === "settled". */
  paymentId?: string;
  /** On-chain tx hash, only when status === "settled". */
  txHash?: string | null;
  /** Provider that ultimately settled, only when status === "settled". */
  providerId?: string | null;
  /** The resource server's response (initial OR post-payment retry). */
  response: PaidEndpointResponse;
  /** Echo the network we paid on, only when status === "settled". */
  network?: string;
}

// ---- x402 spec types (wire format, mirrored locally to keep this
// package decoupled from core-types' Zod 3 schemas — see CLAUDE.md
// isolation pattern). ----

interface NormalizedAccepts {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
  resource?: string;
}

interface NormalizedPaymentRequired {
  x402Version: number;
  accepts: NormalizedAccepts[];
  resource?: string;
  description?: string;
}

const PAYMENT_REQUIRED_HEADER = "payment-required";
const PAYMENT_SIGNATURE_HEADER = "payment-signature";
const PAYMENT_RESPONSE_HEADER = "payment-response";
// Legacy / pragmatic compatibility aliases. Older x402 servers use
// these names; we set both on the outbound request and check both on
// the inbound response.
const LEGACY_X_PAYMENT = "x-payment";
const LEGACY_X_PAYMENT_RESPONSE = "x-payment-response";

/**
 * Resource-side initial call: fetch the URL, capture status, headers,
 * and body without making any assumptions about the body shape.
 */
async function callResource(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<PaidEndpointResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };
    if (body !== undefined && method !== "GET" && method !== "HEAD") {
      if (typeof body === "string") {
        init.body = body;
      } else {
        init.body = JSON.stringify(body);
        if (!hasHeader(headers, "content-type")) {
          (init.headers as Record<string, string>)["content-type"] = "application/json";
        }
      }
    }
    const resp = await fetchImpl(url, init);
    const text = await resp.text();
    let parsedBody: unknown = text;
    if (text.length > 0) {
      const ct = resp.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        try {
          parsedBody = JSON.parse(text);
        } catch {
          parsedBody = text;
        }
      }
    } else {
      parsedBody = null;
    }
    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      respHeaders[k.toLowerCase()] = v;
    });
    return { status: resp.status, headers: respHeaders, body: parsedBody };
  } finally {
    clearTimeout(timer);
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

/**
 * Parse a 402 response into a NormalizedPaymentRequired. Tries the v2
 * PAYMENT-REQUIRED header first (base64 JSON), falls back to the
 * pragmatic / v1 convention of JSON body with `accepts[]`.
 */
function parsePaymentRequired(
  response: PaidEndpointResponse,
): NormalizedPaymentRequired | null {
  // v2 header path
  const header =
    response.headers[PAYMENT_REQUIRED_HEADER] ?? response.headers["x-payment-required"];
  if (header) {
    try {
      const decoded = Buffer.from(header, "base64").toString("utf8");
      const parsed = JSON.parse(decoded) as unknown;
      const norm = normalizePaymentRequired(parsed);
      if (norm !== null) return norm;
    } catch {
      // fall through to body parsing
    }
  }
  // Body path (v1 / pragmatic)
  if (response.body !== null && typeof response.body === "object") {
    const norm = normalizePaymentRequired(response.body);
    if (norm !== null) return norm;
  }
  return null;
}

function normalizePaymentRequired(raw: unknown): NormalizedPaymentRequired | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const acceptsRaw = obj.accepts;
  if (!Array.isArray(acceptsRaw)) return null;
  const x402Version =
    typeof obj.x402Version === "number" ? obj.x402Version : 2;
  const accepts: NormalizedAccepts[] = [];
  let topLevelResource: string | undefined;
  if (typeof obj.resource === "string") {
    topLevelResource = obj.resource;
  } else if (obj.resource && typeof obj.resource === "object") {
    const r = obj.resource as Record<string, unknown>;
    if (typeof r.url === "string") topLevelResource = r.url;
  }
  for (const entry of acceptsRaw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const scheme = typeof e.scheme === "string" ? e.scheme : null;
    const network = typeof e.network === "string" ? e.network : null;
    // amount in v2 spec; maxAmountRequired in gateway / some v1 impls.
    const amount =
      typeof e.amount === "string"
        ? e.amount
        : typeof e.maxAmountRequired === "string"
          ? e.maxAmountRequired
          : null;
    const asset = typeof e.asset === "string" ? e.asset : null;
    const payTo = typeof e.payTo === "string" ? e.payTo : null;
    if (scheme === null || network === null || amount === null || asset === null || payTo === null)
      continue;
    const item: NormalizedAccepts = { scheme, network, amount, asset, payTo };
    if (typeof e.maxTimeoutSeconds === "number") item.maxTimeoutSeconds = e.maxTimeoutSeconds;
    if (e.extra && typeof e.extra === "object")
      item.extra = e.extra as Record<string, unknown>;
    const perAcceptResource = typeof e.resource === "string" ? e.resource : undefined;
    const finalResource = perAcceptResource ?? topLevelResource;
    if (finalResource !== undefined) item.resource = finalResource;
    accepts.push(item);
  }
  if (accepts.length === 0) return null;
  const out: NormalizedPaymentRequired = { x402Version, accepts };
  if (topLevelResource !== undefined) out.resource = topLevelResource;
  return out;
}

interface ChosenAccept {
  accept: NormalizedAccepts;
  family: "cosmos" | "evm";
}

/**
 * Pick the first accepts[] entry that this session can sign:
 *   - cosmos:* + scheme name contains "cosmos" → signer-cosmos
 *   - eip155:* + scheme === "exact" → signer-evm
 * Sessions only sign for the networks they declared at init.
 */
function selectCompatibleAccept(
  session: Session,
  pr: NormalizedPaymentRequired,
): ChosenAccept | null {
  const sessionNets = new Set(session.networks);
  for (const a of pr.accepts) {
    if (!sessionNets.has(a.network)) continue;
    if (isCosmosNetwork(a.network) && a.scheme.includes("cosmos")) {
      return { accept: a, family: "cosmos" };
    }
    if (isEvmNetwork(a.network) && a.scheme === "exact") {
      return { accept: a, family: "evm" };
    }
  }
  return null;
}

/**
 * Idempotency-Key derivation — REDESIGNED per Phase 2 review item 3.
 *
 * Key = sha256(
 *     payerAddress || "|" ||
 *     network      || "|" ||
 *     url          || "|" ||
 *     sha256(bodyJson || "") || "|" ||
 *     hourBucket
 *   )
 *
 * - **payerAddress** (NOT sessionId): a new MCP session for the same
 *   wallet should be idempotent against repeat calls from a prior
 *   session that hit the same (url, body) within the hour. Session
 *   IDs rotate on every restart; addresses don't.
 * - **hourBucket** = floor(now / 3_600_000): the same call within the
 *   same wall-clock hour is idempotent (so client retries dedupe).
 *   The same call an hour later mints a fresh key, so legitimate
 *   re-payment of the same resource later in the day is not blocked
 *   by a frozen idempotency record.
 * - **First 16 bytes hex-encoded → 32-char key**: matches the
 *   gateway's expected format and is plenty unique.
 */
export function deriveIdempotencyKey(args: {
  payerAddress: string;
  network: string;
  url: string;
  body: unknown;
  now: number;
}): string {
  const bodyText = args.body === undefined ? "" : JSON.stringify(args.body);
  const bodyHash = createHash("sha256").update(bodyText, "utf8").digest("hex");
  const hourBucket = Math.floor(args.now / 3_600_000).toString();
  const preimage = [args.payerAddress, args.network, args.url, bodyHash, hourBucket].join("|");
  return createHash("sha256").update(preimage, "utf8").digest("hex").slice(0, 32);
}

function buildPaymentPayloadEnvelope(
  signed: { paymentPayload: unknown; paymentRequirements: unknown },
  accept: NormalizedAccepts,
  resourceUrl: string,
): string {
  // x402 v2 PaymentPayload envelope: { x402Version, resource, accepted, payload }
  const requirements = signed.paymentRequirements as Record<string, unknown>;
  const payload = signed.paymentPayload as Record<string, unknown>;
  const envelope = {
    x402Version: typeof payload.x402Version === "number" ? payload.x402Version : 2,
    resource: { url: resourceUrl },
    accepted: requirements ?? accept,
    payload: payload.payload,
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

function decodePaymentResponseHeader(headers: Record<string, string>): unknown {
  const raw =
    headers[PAYMENT_RESPONSE_HEADER] ?? headers[LEGACY_X_PAYMENT_RESPONSE];
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return raw;
  }
}

export async function handlePayAndCall(
  input: PayAndCallInput,
  deps: PayAndCallDeps,
): Promise<ToolResult<PayAndCallResult>> {
  const lookup = loadSession(deps.store, input.sessionId);
  if (!lookup.ok) return { ok: false, error: lookup.error };
  const session = lookup.session;

  if (session.networks.length === 0) {
    return {
      ok: false,
      error: {
        code: "session_has_no_networks",
        message: "session has no supported networks",
      },
    };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const method = (input.method ?? "GET").toUpperCase();
  const extHeaders: Record<string, string> = { ...(input.headers ?? {}) };

  // Step 2: initial call.
  let initial: PaidEndpointResponse;
  try {
    initial = await callResource(
      input.url,
      method,
      extHeaders,
      input.body,
      deps.config.externalCallTimeoutMs,
      fetchImpl,
    );
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "resource_unreachable",
        message: `initial call to ${input.url} failed: ${safeErrorMessage(err)}`,
      },
    };
  }

  // Step 3: non-402 → return response as-is.
  if (initial.status !== 402) {
    session.touch();
    return {
      ok: true,
      result: {
        status: "no_payment_required",
        response: initial,
      },
    };
  }

  // Step 4a: parse PaymentRequirements.
  const paymentRequired = parsePaymentRequired(initial);
  if (paymentRequired === null) {
    return {
      ok: false,
      error: {
        code: "unparseable_402",
        message:
          "endpoint returned 402 but PaymentRequirements could not be parsed " +
          "(neither PAYMENT-REQUIRED header nor body.accepts[] was recognizable)",
      },
    };
  }

  // Step 4b: pick a compatible accept.
  const chosen = selectCompatibleAccept(session, paymentRequired);
  if (chosen === null) {
    const offered = paymentRequired.accepts
      .map((a) => `${a.network}/${a.scheme}/${a.asset}`)
      .join(", ");
    return {
      ok: false,
      error: {
        code: "no_compatible_payment_option",
        message:
          `endpoint offers [${offered}] but this session is configured for ` +
          `[${session.networks.join(", ")}]`,
      },
    };
  }

  const payerAddress = session.addresses[chosen.accept.network];
  if (payerAddress === undefined) {
    // Shouldn't happen because selectCompatibleAccept already requires
    // session.networks membership, but it's a useful defensive net.
    return {
      ok: false,
      error: {
        code: "no_address_for_network",
        message: `session has no derived address for ${chosen.accept.network}`,
      },
    };
  }

  // Step 4c: sign. session.useSecret(...) is the only mechanism that
  // can read the secret — it also touches the session. We thread the
  // signer call inside so the secret is never copied outside.
  let signed: { paymentPayload: unknown; paymentRequirements: unknown };
  try {
    if (chosen.family === "cosmos") {
      signed = await session.useSecret(async (secretBuf) => {
        const mnemonic = secretBuf.toString("utf8");
        return signCosmosPaymentPayload({
          mnemonic,
          network: chosen.accept.network,
          requirements: buildCosmosRequirements(chosen.accept, input.url),
          amount: chosen.accept.amount,
          ...(chosen.accept.maxTimeoutSeconds !== undefined
            ? { validitySeconds: Math.min(chosen.accept.maxTimeoutSeconds - 1, 50) }
            : {}),
        });
      });
    } else {
      signed = await session.useSecret(async (secretBuf) => {
        const secret = secretBuf.toString("utf8");
        return signEvmPaymentPayload({
          secret,
          network: chosen.accept.network,
          requirements: buildEvmRequirements(chosen.accept, input.url),
          amount: chosen.accept.amount,
          ...(chosen.accept.maxTimeoutSeconds !== undefined
            ? { validitySeconds: Math.min(chosen.accept.maxTimeoutSeconds - 1, 50) }
            : {}),
        });
      });
    }
  } catch (err) {
    // safeErrorMessage / sanitize: signer error messages come from our
    // own packages and have been audited to never include the secret.
    return {
      ok: false,
      error: {
        code: "signing_failed",
        message: `signing failed: ${safeErrorMessage(err)}`,
      },
    };
  }

  // Step 4d: idempotency key (REDESIGNED per review item 3).
  const idempotencyKey = deriveIdempotencyKey({
    payerAddress,
    network: chosen.accept.network,
    url: input.url,
    body: input.body,
    now: now(),
  });

  // Step 4e: POST /settle.
  let settleResp: unknown;
  try {
    settleResp = await deps.gateway.settle(
      {
        paymentPayload: signed.paymentPayload,
        paymentRequirements: signed.paymentRequirements,
      },
      idempotencyKey,
    );
  } catch (err) {
    if (err instanceof GatewayError) {
      return {
        ok: false,
        error: {
          code: err.code ?? "settle_failed",
          message: err.message,
        },
      };
    }
    return {
      ok: false,
      error: { code: "settle_failed", message: safeErrorMessage(err) },
    };
  }

  // Step 4f: parse gateway response.
  const settled = parseSettleResponse(settleResp);
  if (!settled.ok) {
    return {
      ok: false,
      error: settled.error,
    };
  }

  // Step 4h: build the X-PAYMENT-style header for the resource retry.
  const paymentHeader = buildPaymentPayloadEnvelope(signed, chosen.accept, input.url);

  // Step 4i: retry the original call with payment proof.
  const retryHeaders: Record<string, string> = {
    ...extHeaders,
    [PAYMENT_SIGNATURE_HEADER]: paymentHeader,
    // Also include the legacy x-payment header — many v1-era servers
    // only check this name. Cheap dual-write.
    [LEGACY_X_PAYMENT]: paymentHeader,
  };

  let retry: PaidEndpointResponse;
  try {
    retry = await callResource(
      input.url,
      method,
      retryHeaders,
      input.body,
      deps.config.externalCallTimeoutMs,
      fetchImpl,
    );
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "resource_retry_failed",
        message: `retry call after settlement failed: ${safeErrorMessage(err)}`,
      },
    };
  }

  // If the resource server still returns 402 after a settled payment,
  // surface that clearly — settlement took effect on-chain but the
  // resource server didn't recognize the proof.
  if (retry.status === 402) {
    return {
      ok: false,
      error: {
        code: "payment_not_recognized_after_settle",
        message:
          `payment settled (txHash=${settled.txHash ?? "n/a"}, paymentId=${settled.paymentId}) ` +
          `but ${input.url} still returned 402 on retry. ` +
          `The settlement is final on-chain; the resource server may need to refresh its index.`,
      },
    };
  }

  // Decode any PAYMENT-RESPONSE header for callers who want it.
  const paymentResponseDecoded = decodePaymentResponseHeader(retry.headers);
  if (paymentResponseDecoded !== null && retry.body !== null) {
    // Attach for visibility without overwriting the actual response body.
    retry.headers["payment-response-decoded"] = JSON.stringify(paymentResponseDecoded);
  }

  session.touch();
  return {
    ok: true,
    result: {
      status: "settled",
      paymentId: settled.paymentId,
      txHash: settled.txHash ?? null,
      providerId: settled.providerId ?? null,
      network: chosen.accept.network,
      response: retry,
    },
  };
}

function buildCosmosRequirements(
  accept: NormalizedAccepts,
  resource: string,
): CosmosPaymentRequirements {
  const extra = (accept.extra ?? {}) as Record<string, unknown>;
  // ADR-036 cosmos signing needs the facilitator (grantee) address —
  // it's what the MsgExec is granted to, baked into the signed
  // payload. cosmos-pay returns this in PaymentRequirements.extra.
  const facilitator = typeof extra.facilitator === "string" ? extra.facilitator : null;
  if (facilitator === null || facilitator.length === 0) {
    throw new Error(
      "cosmos accepts entry missing extra.facilitator " +
        "(grantee bech32 address — required for ADR-036 authz signing)",
    );
  }
  const chainIdFromExtra = typeof extra.chainId === "string" ? extra.chainId : undefined;
  const decimals = typeof extra.decimals === "number" ? extra.decimals : undefined;
  const symbol = typeof extra.symbol === "string" ? extra.symbol : undefined;
  return {
    scheme: accept.scheme,
    network: accept.network,
    maxAmountRequired: accept.amount,
    asset: accept.asset,
    payTo: accept.payTo,
    resource,
    maxTimeoutSeconds: accept.maxTimeoutSeconds ?? 60,
    extra: {
      facilitator,
      chainId: chainIdFromExtra ?? accept.network.replace(/^cosmos:/, ""),
      ...(decimals !== undefined ? { decimals } : {}),
      ...(symbol !== undefined ? { symbol } : {}),
    },
  };
}

function buildEvmRequirements(
  accept: NormalizedAccepts,
  resource: string,
): {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  asset: `0x${string}`;
  payTo: `0x${string}`;
  resource: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; decimals?: number; symbol?: string };
} {
  const extra = (accept.extra ?? {}) as Record<string, unknown>;
  const name = typeof extra.name === "string" ? extra.name : "";
  const version = typeof extra.version === "string" ? extra.version : "";
  if (name.length === 0 || version.length === 0) {
    throw new Error(
      `EVM accepts entry missing extra.name / extra.version (required for EIP-712 domain construction)`,
    );
  }
  const decimals = typeof extra.decimals === "number" ? extra.decimals : undefined;
  const symbol = typeof extra.symbol === "string" ? extra.symbol : undefined;
  const out = {
    scheme: accept.scheme,
    network: accept.network,
    maxAmountRequired: accept.amount,
    asset: accept.asset as `0x${string}`,
    payTo: accept.payTo as `0x${string}`,
    resource,
    maxTimeoutSeconds: accept.maxTimeoutSeconds ?? 60,
    extra: {
      name,
      version,
      ...(decimals !== undefined ? { decimals } : {}),
      ...(symbol !== undefined ? { symbol } : {}),
    },
  };
  return out;
}

function parseSettleResponse(
  raw: unknown,
):
  | { ok: true; paymentId: string; txHash?: string | null; providerId?: string | null }
  | { ok: false; error: { code: string; message: string } } {
  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      error: {
        code: "unexpected_gateway_response",
        message: "gateway /settle returned a non-object response",
      },
    };
  }
  const obj = raw as Record<string, unknown>;
  const status = obj.status;
  const paymentId = obj.paymentId;
  if (typeof paymentId !== "string") {
    return {
      ok: false,
      error: {
        code: "unexpected_gateway_response",
        message: "gateway /settle response missing paymentId",
      },
    };
  }
  if (status !== "settled") {
    return {
      ok: false,
      error: {
        code: typeof obj.errorCode === "string" ? obj.errorCode : "settle_not_settled",
        message:
          (typeof obj.errorMessage === "string" ? obj.errorMessage : `status=${String(status)}`) +
          ` (paymentId=${paymentId})`,
      },
    };
  }
  return {
    ok: true,
    paymentId,
    txHash: typeof obj.txHash === "string" ? obj.txHash : null,
    providerId: typeof obj.providerId === "string" ? obj.providerId : null,
  };
}
