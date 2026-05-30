/**
 * Parse a seller's 402 challenge body into our normalised
 * `ChallengeBody` shape. Accepts both Coinbase v2 (top-level
 * structured `resource`, per-accept `amount` + `maxTimeoutSeconds`)
 * and legacy v1 (per-accept `resource` string, per-accept
 * `maxAmountRequired`). The two are normalised to v2.
 *
 * The challenge can arrive via two channels:
 *   - As a JSON body (every spec-compliant 402)
 *   - As a base64 `PAYMENT-REQUIRED` HTTP header (the v2 ecosystem
 *     way; see @x402/fetch + @suverselabs/x402-server)
 *
 * Both feed through the same parser.
 */

import {
  type AcceptedRequirement,
  type ChallengeBody,
  type ResourceInfo,
  X402ClientError,
} from "../types.js";

/**
 * Parse from a raw object (typically `await response.json()`).
 *
 * @param resourceUrlFallback URL the buyer hit. Used to fill `resource.url`
 * when the seller emitted a v1 challenge without a structured resource
 * (the v1 spec put resource as a string ON each accept entry; we surface
 * the first non-empty one and fall back to the URL the buyer hit).
 */
export function parseChallenge(
  body: unknown,
  resourceUrlFallback: string,
): ChallengeBody {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new X402ClientError(
      "invalid_challenge",
      "challenge body must be a JSON object",
    );
  }
  const o = body as Record<string, unknown>;
  const x402Version = parseVersion(o["x402Version"]);
  const acceptsRaw =
    (o["accepts"] as unknown) ?? (o["paymentRequirements"] as unknown);
  if (!Array.isArray(acceptsRaw) || acceptsRaw.length === 0) {
    throw new X402ClientError(
      "invalid_challenge",
      "challenge missing non-empty 'accepts' (v2) or 'paymentRequirements' (v1) array",
    );
  }
  const accepts = acceptsRaw.map((entry, idx) =>
    parseRequirement(entry, idx, resourceUrlFallback),
  );

  const resource = parseResource(o["resource"], accepts, resourceUrlFallback);

  const description =
    typeof o["description"] === "string"
      ? (o["description"] as string)
      : undefined;
  const error =
    typeof o["error"] === "string" ? (o["error"] as string) : undefined;

  return {
    x402Version,
    resource,
    accepts,
    ...(description !== undefined ? { description } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * Parse from a base64-encoded `PAYMENT-REQUIRED` header value.
 */
export function parseChallengeHeader(
  headerValue: string,
  resourceUrlFallback: string,
): ChallengeBody {
  let json: string;
  try {
    json = Buffer.from(headerValue.trim(), "base64").toString("utf8");
  } catch (err) {
    throw new X402ClientError(
      "invalid_challenge",
      `PAYMENT-REQUIRED header is not valid base64: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new X402ClientError(
      "invalid_challenge",
      `PAYMENT-REQUIRED header is not valid JSON: ${(err as Error).message}`,
    );
  }
  return parseChallenge(parsed, resourceUrlFallback);
}

// ---------------------------------------------------------------
// Internals
// ---------------------------------------------------------------

function parseVersion(raw: unknown): 1 | 2 {
  if (raw === 1 || raw === 2) return raw;
  if (raw === undefined) return 2; // be lenient — default to v2
  throw new X402ClientError(
    "invalid_challenge",
    `unsupported x402Version: ${String(raw)}`,
  );
}

function parseRequirement(
  raw: unknown,
  idx: number,
  resourceUrlFallback: string,
): AcceptedRequirement {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new X402ClientError(
      "invalid_challenge",
      `accepts[${idx}] must be an object`,
    );
  }
  const o = raw as Record<string, unknown>;
  const scheme = requireString(o, "scheme", `accepts[${idx}].scheme`);
  const network = requireString(o, "network", `accepts[${idx}].network`);
  const asset = requireString(o, "asset", `accepts[${idx}].asset`);
  const payTo = requireString(o, "payTo", `accepts[${idx}].payTo`);

  // v2 uses `amount`; v1 uses `maxAmountRequired`. Accept either.
  const amountRaw = o["amount"] ?? o["maxAmountRequired"];
  if (typeof amountRaw !== "string" || amountRaw.length === 0) {
    throw new X402ClientError(
      "invalid_challenge",
      `accepts[${idx}] missing 'amount' (v2) / 'maxAmountRequired' (v1) string`,
    );
  }

  // v2 carries maxTimeoutSeconds as number; v1 may omit (default to 60).
  let maxTimeoutSeconds = 60;
  if (typeof o["maxTimeoutSeconds"] === "number") {
    maxTimeoutSeconds = o["maxTimeoutSeconds"];
  } else if (
    typeof o["maxTimeoutSeconds"] === "string" &&
    /^[1-9][0-9]*$/.test(o["maxTimeoutSeconds"])
  ) {
    maxTimeoutSeconds = Number(o["maxTimeoutSeconds"]);
  }

  const description =
    typeof o["description"] === "string"
      ? (o["description"] as string)
      : undefined;
  const extra =
    o["extra"] !== null && typeof o["extra"] === "object"
      ? (o["extra"] as Record<string, unknown>)
      : undefined;

  // v1 carried `resource` on each accept — we promote it to top-level
  // when the v2 `resource` object is absent (handled in
  // `parseResource`); here we just keep it in extra for callers that
  // care.
  if (typeof o["resource"] === "string" && extra === undefined) {
    void resourceUrlFallback; // unused here — promoted upstream
  }

  return {
    scheme,
    network,
    asset,
    payTo,
    amount: amountRaw,
    maxTimeoutSeconds,
    ...(description !== undefined ? { description } : {}),
    ...(extra !== undefined ? { extra } : {}),
  };
}

function parseResource(
  raw: unknown,
  accepts: readonly AcceptedRequirement[],
  fallback: string,
): ResourceInfo {
  // v2 — structured top-level
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const url = typeof o["url"] === "string" ? (o["url"] as string) : fallback;
    const description =
      typeof o["description"] === "string"
        ? (o["description"] as string)
        : undefined;
    const mimeType =
      typeof o["mimeType"] === "string" ? (o["mimeType"] as string) : undefined;
    return {
      url,
      ...(description !== undefined ? { description } : {}),
      ...(mimeType !== undefined ? { mimeType } : {}),
    };
  }
  // v1 — `resource` lives on the first accept, as a string.
  void accepts;
  return { url: fallback };
}

function requireString(
  o: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const v = o[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new X402ClientError(
      "invalid_challenge",
      `${label} must be a non-empty string`,
    );
  }
  return v;
}
