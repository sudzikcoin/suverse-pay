import { createHash } from "node:crypto";
import { z } from "zod";
import {
  signPaymentPayload as signCosmosPaymentPayload,
  type PaymentRequirements as CosmosPaymentRequirements,
} from "@suverse-pay/signer-cosmos";
import { signPaymentPayload as signEvmPaymentPayload } from "@suverse-pay/signer-evm";
import type { Config } from "../config.js";
import type { GatewayClient } from "../gateway-client.js";
import { isCosmosNetwork, isEvmNetwork } from "../networks.js";
import type { Session, SessionStore } from "../session.js";
import { loadSession, safeErrorMessage, type ToolResult } from "./session-helper.js";

// Module-scoped in-memory idempotency cache, keyed by
// deriveIdempotencyKey(...). Stores the final tool result so a replay
// of the same call within the same hour bucket returns the same
// txHash WITHOUT re-signing or re-submitting (which would mint a
// second on-chain tx since neither x402 v2 nor cosmos-pay tracks
// nonces server-side).
//
// Scope: per-process. Lost on MCP restart — which is acceptable
// because a new process boots a fresh session anyway.
const idempotencyCache = new Map<string, PayAndCallResult>();

/** Test-only — clear the cache between tests. */
export function _resetIdempotencyCacheForTests(): void {
  idempotencyCache.clear();
}

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
  /**
   * Synthetic MCP-side payment id (`mcp_<first16hex>`), derived from
   * the same key as the idempotency cache. Stable across replays of
   * the same (payerAddress, network, url, body, hourBucket).
   */
  paymentId?: string;
  /**
   * On-chain tx hash from the resource server's PAYMENT-RESPONSE
   * header (the resource server's middleware obtains it from
   * whichever facilitator it's configured against).
   */
  txHash?: string | null;
  /** The resource server's response (initial OR post-payment retry). */
  response: PaidEndpointResponse;
  /** Echo the network we paid on, only when status === "settled". */
  network?: string;
  /**
   * True on a cache hit — meaning the agent already paid this (url,
   * body) within the same hour and we returned the cached result
   * without re-signing or re-submitting. No second on-chain tx.
   */
  idempotentReplay?: boolean;
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
  const x402Version =
    typeof obj.x402Version === "number" ? obj.x402Version : 2;
  let topLevelResource: string | undefined;
  if (typeof obj.resource === "string") {
    topLevelResource = obj.resource;
  } else if (obj.resource && typeof obj.resource === "object") {
    const r = obj.resource as Record<string, unknown>;
    if (typeof r.url === "string") topLevelResource = r.url;
  }

  // Three shapes seen in the wild:
  //   1. v2 spec wrapper:   { x402Version, accepts: [PaymentRequirements, ...] }
  //   2. v1 body wrapper:   { accepts: [...] }  (no x402Version)
  //   3. Flat single requirements (cosmos-pay middleware):
  //        { scheme, network, asset, payTo, maxAmountRequired, extra, ... }
  // Treat shape 3 as a single-element accepts list.
  const acceptsRaw = Array.isArray(obj.accepts)
    ? (obj.accepts as unknown[])
    : looksLikeSingleRequirements(obj)
      ? [obj]
      : null;
  if (acceptsRaw === null) return null;

  const accepts: NormalizedAccepts[] = [];
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

function looksLikeSingleRequirements(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.scheme === "string" &&
    typeof obj.network === "string" &&
    typeof obj.asset === "string" &&
    typeof obj.payTo === "string" &&
    (typeof obj.amount === "string" || typeof obj.maxAmountRequired === "string")
  );
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
  _accept: NormalizedAccepts,
  _resourceUrl: string,
): string {
  // Both signer-cosmos and signer-evm return a PaymentPayload shaped
  // like the cosmos-pay middleware / facilitator expect:
  //   { x402Version, scheme, network, payload: <scheme-specific> }
  // This is also what real-world x402 servers (cosmos-pay-derived
  // middleware, Coinbase x402-py reference) decode.
  //
  // Note: the v2 spec docs describe a longer envelope with `accepted`
  // and `resource` siblings, but the live cosmos-pay code requires
  // the flat shape — Go json.Unmarshal would treat unknown fields as
  // benign but missing scheme/network would fail. We emit the flat
  // shape verbatim.
  return Buffer.from(JSON.stringify(signed.paymentPayload), "utf8").toString("base64");
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

  // Idempotency cache lookup BEFORE the network call. If we already
  // paid this (url, body, payerAddress) within the same hour, return
  // the cached result without touching the resource server or the
  // signer — no second on-chain tx, no second signature.
  const sessionAddresses = session.addresses;
  // Use the FIRST cosmos / evm address we know about as the cache key
  // input. If multiple networks are advertised by the endpoint, the
  // signing path picks a specific one — but the cache key is computed
  // before parsing 402, so we use a stable session-level address.
  // Concretely: a session with one network has one address; sessions
  // with mixed networks use the first.
  const firstAddress = Object.values(sessionAddresses)[0] ?? "";
  const firstNetwork = session.networks[0] ?? "";
  const cacheKey = deriveIdempotencyKey({
    payerAddress: firstAddress,
    network: firstNetwork,
    url: input.url,
    body: input.body,
    now: now(),
  });
  const cached = idempotencyCache.get(cacheKey);
  if (cached !== undefined && cached.status === "settled") {
    session.touch();
    return {
      ok: true,
      result: { ...cached, idempotentReplay: true },
    };
  }

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

  // Step 4d: build PAYMENT-SIGNATURE envelope and submit DIRECTLY to
  // the resource server. The resource server's middleware will forward
  // the payment to whatever facilitator it's configured with
  // (cosmos-pay in our smoke). We deliberately do NOT pre-call the
  // suverse-pay gateway's /settle — that's a facilitator-side endpoint
  // for resource-server integrations, not for agent-side payment.
  // See apps/mcp/README.md "Architecture" for the full rationale.
  const paymentHeader = buildPaymentPayloadEnvelope(signed, chosen.accept, input.url);
  const retryHeaders: Record<string, string> = {
    ...extHeaders,
    [PAYMENT_SIGNATURE_HEADER]: paymentHeader,
    // Also set the legacy x-payment alias — older / pragmatic servers
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
        message: `retry call to ${input.url} with payment failed: ${safeErrorMessage(err)}`,
      },
    };
  }

  // 402 on retry means the resource server's middleware rejected the
  // payment. Decode any PAYMENT-RESPONSE failure reason for the agent.
  if (retry.status === 402) {
    const settle = decodePaymentResponseHeader(retry.headers);
    let reason = "no PAYMENT-RESPONSE header";
    if (settle && typeof settle === "object") {
      const s = settle as Record<string, unknown>;
      if (typeof s.errorReason === "string") reason = s.errorReason;
    }
    return {
      ok: false,
      error: {
        code: "payment_rejected",
        message:
          `${input.url} rejected the payment on retry — facilitator settlement failed. ` +
          `reason: ${reason}`,
      },
    };
  }

  // Decode the PAYMENT-RESPONSE header — that's where the resource
  // server (via its facilitator) reports the on-chain txHash and the
  // payer address. Attach the decoded value as a synthetic header for
  // agent visibility without touching the actual response body.
  const paymentResponseDecoded = decodePaymentResponseHeader(retry.headers);
  let txHash: string | null = null;
  if (paymentResponseDecoded && typeof paymentResponseDecoded === "object") {
    const pr = paymentResponseDecoded as Record<string, unknown>;
    if (typeof pr.transaction === "string" && pr.transaction.length > 0) {
      txHash = pr.transaction;
    }
    retry.headers["payment-response-decoded"] = JSON.stringify(paymentResponseDecoded);
  }

  const result: PayAndCallResult = {
    status: "settled",
    paymentId: `mcp_${cacheKey}`,
    txHash,
    network: chosen.accept.network,
    response: retry,
  };
  idempotencyCache.set(cacheKey, result);
  session.touch();
  return { ok: true, result };
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

