/**
 * Upstream-x402 wrapping client.
 *
 * When seller_proxy_configs.upstream_x402_enabled is true, the proxy
 * itself is a buyer to the upstream API. The flow:
 *
 *   1. fetch(upstreamUrl) with the customer's headers + body.
 *   2. If 200 → pass straight back.
 *   3. If 5xx / network error → surface as upstream_unavailable.
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

export interface UpstreamX402Deps {
  /** SuverseClient instance carrying the service wallets. */
  client: SuverseClient;
  /** Map namespace → service-wallet public address (for logging). */
  addresses: ServiceAddresses;
  fetchImpl: typeof fetch;
  logger?: Pick<Console, "info" | "warn" | "error">;
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

  let first: Response;
  try {
    first = await deps.fetchImpl(args.upstreamUrl, initialInit);
  } catch (err) {
    deps.logger?.warn?.(
      `upstream-x402: initial fetch failed url=${args.upstreamUrl}`,
      err,
    );
    return {
      kind: "error",
      reason: "network_error",
      message: (err as Error).message,
    };
  }

  // 200 — no payment was needed (e.g. cached endpoint, or first hit
  // before throttle). Forward as-is, the buyer still paid us, our
  // margin is 100%.
  if (first.status === 200) {
    const buf = Buffer.from(await first.arrayBuffer());
    return { kind: "passthrough", response: first, bodyBuffer: buf };
  }

  if (first.status >= 500) {
    return {
      kind: "error",
      reason: "upstream_5xx",
      upstreamStatus: first.status,
      message: `upstream returned ${first.status}`,
    };
  }

  if (first.status !== 402) {
    // 4xx that isn't 402 — pass through verbatim. The buyer paid us
    // and deserves to see the upstream's actual error (e.g. 400 bad
    // signature on the user's body, 404 unknown route).
    const buf = Buffer.from(await first.arrayBuffer());
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

  let retry: Response;
  try {
    retry = await deps.fetchImpl(args.upstreamUrl, {
      method: args.method,
      headers: retryHeaders,
      body: args.body && args.body.length > 0 ? args.body : undefined,
    });
  } catch (err) {
    return {
      kind: "error",
      reason: "network_error",
      message: (err as Error).message,
    };
  }

  if (retry.status !== 200) {
    return {
      kind: "error",
      reason: "retry_not_200",
      upstreamStatus: retry.status,
      message: `upstream retry after payment returned HTTP ${retry.status}`,
    };
  }

  const buf = Buffer.from(await retry.arrayBuffer());
  const txHash = extractTxHash(retry);

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
