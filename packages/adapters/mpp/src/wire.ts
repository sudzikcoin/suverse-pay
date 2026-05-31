/**
 * MPP wire-format translation primitives. Phase 4 Block 2 Sub-task 9.
 *
 *   - Build a `WWW-Authenticate: Payment` header line from an
 *     `MppChallenge` (server side, when emitting a 402 response).
 *   - Parse a `WWW-Authenticate: Payment` header line back into a
 *     structured `MppChallenge` (client side).
 *   - Encode/decode the credential carried in `Authorization: Payment`.
 *
 * The 402 challenge encoding is RFC-7235-flavored: a scheme name
 * (`Payment`) followed by comma-separated `key="value"` parameters.
 * Values that need to be JSON go through base64url so they survive
 * the parameter format.
 *
 * Multiple challenges (one per (method, intent) pair the resource
 * accepts) appear as multiple `WWW-Authenticate` headers; this
 * module handles one challenge at a time, callers are responsible
 * for emitting/parsing the header list.
 */
import {
  base64urlDecode,
  base64urlEncode,
  MppChallengeSchema,
  MppCredentialSchema,
  type MppChallenge,
  type MppCredential,
} from "./types.js";

const PAYMENT_SCHEME_PREFIX = "Payment ";

/* --- Challenge -> WWW-Authenticate parameters --- */

/**
 * Encode an `MppChallenge` into the value of a
 * `WWW-Authenticate` header line (the substring after `Payment `).
 *
 * Parameters always emitted: `id`, `realm`, `method`, `intent`,
 * `request`. Optional parameters (`description`, `expires`,
 * `digest`, `opaque`) are emitted when present.
 */
export function challengeToHeaderValue(challenge: MppChallenge): string {
  const parts: string[] = [];
  parts.push(`id="${quote(challenge.id)}"`);
  parts.push(`realm="${quote(challenge.realm)}"`);
  parts.push(`method="${quote(challenge.method)}"`);
  parts.push(`intent="${quote(challenge.intent)}"`);
  // `request` is structured JSON — encode as base64url so it
  // survives the WWW-Authenticate parameter format.
  parts.push(`request="${base64urlEncode(JSON.stringify(challenge.request))}"`);
  if (challenge.description !== undefined) {
    parts.push(`description="${quote(challenge.description)}"`);
  }
  if (challenge.expires !== undefined) {
    parts.push(`expires="${quote(challenge.expires)}"`);
  }
  if (challenge.digest !== undefined) {
    parts.push(`digest="${quote(challenge.digest)}"`);
  }
  if (challenge.opaque !== undefined) {
    parts.push(`opaque="${quote(challenge.opaque)}"`);
  }
  if (challenge.meta !== undefined) {
    parts.push(`meta="${base64urlEncode(JSON.stringify(challenge.meta))}"`);
  }
  return parts.join(", ");
}

/**
 * Compose a complete `WWW-Authenticate` header line, prefix
 * included.
 */
export function challengeToHeaderLine(challenge: MppChallenge): string {
  return PAYMENT_SCHEME_PREFIX + challengeToHeaderValue(challenge);
}

/* --- WWW-Authenticate parameters -> Challenge --- */

/**
 * Parse a `WWW-Authenticate: Payment ...` header value into an
 * `MppChallenge`. Throws on malformed input — callers should catch
 * + skip or report.
 */
export function challengeFromHeaderLine(line: string): MppChallenge {
  let body = line.trim();
  if (body.toLowerCase().startsWith("payment ")) {
    body = body.slice("payment ".length).trim();
  }
  const params = parseHttpHeaderParams(body);
  const requestJson = params["request"];
  if (requestJson === undefined) {
    throw new Error("MPP challenge missing required `request` parameter");
  }
  const rawRequest = base64urlDecode(requestJson);
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(rawRequest) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `MPP challenge \`request\` parameter is not valid base64url JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const candidate: Record<string, unknown> = {
    id: params["id"],
    realm: params["realm"],
    method: params["method"],
    intent: params["intent"],
    request,
  };
  if (params["description"] !== undefined) {
    candidate["description"] = params["description"];
  }
  if (params["expires"] !== undefined) candidate["expires"] = params["expires"];
  if (params["digest"] !== undefined) candidate["digest"] = params["digest"];
  if (params["opaque"] !== undefined) candidate["opaque"] = params["opaque"];
  if (params["meta"] !== undefined) {
    try {
      candidate["meta"] = JSON.parse(base64urlDecode(params["meta"])) as Record<
        string,
        string
      >;
    } catch {
      // Best-effort: silently drop malformed meta rather than failing
      // the whole challenge.
    }
  }
  const parsed = MppChallengeSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`MPP challenge fields invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

/* --- Credential <-> Authorization: Payment <base64url JSON> --- */

/**
 * Encode an `MppCredential` into the value of an
 * `Authorization: Payment <token>` header.
 */
export function credentialToHeaderValue(credential: MppCredential): string {
  return base64urlEncode(JSON.stringify(credential));
}

/**
 * Compose a complete `Authorization: Payment <token>` line.
 */
export function credentialToHeaderLine(credential: MppCredential): string {
  return `Payment ${credentialToHeaderValue(credential)}`;
}

/**
 * Parse the `Authorization: Payment <token>` header value back into
 * an `MppCredential`. Accepts the value with or without the
 * `Payment ` scheme prefix.
 */
export function credentialFromHeaderLine(line: string): MppCredential {
  let body = line.trim();
  if (body.toLowerCase().startsWith("payment ")) {
    body = body.slice("payment ".length).trim();
  }
  const decoded = base64urlDecode(body);
  let json: unknown;
  try {
    json = JSON.parse(decoded);
  } catch (err) {
    throw new Error(
      `MPP credential is not valid base64url JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const parsed = MppCredentialSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`MPP credential fields invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

/* --- Internals --- */

/**
 * Minimal RFC-7235 / RFC-7230 parameter parser. Accepts `key="value"`
 * or bare `key=value` pairs, comma-separated. Handles backslash
 * escapes inside quoted strings (`\"` and `\\`).
 *
 * Not exposed — callers go through `challengeFromHeaderLine`.
 */
function parseHttpHeaderParams(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < input.length) {
    // Skip whitespace + commas between params.
    while (i < input.length && /[\s,]/.test(input[i]!)) i++;
    if (i >= input.length) break;
    // Read key (up to `=`).
    const keyStart = i;
    while (i < input.length && input[i] !== "=") i++;
    if (i >= input.length) break;
    const key = input.slice(keyStart, i).trim();
    i++; // skip `=`
    let value: string;
    if (input[i] === '"') {
      // Quoted value with escape handling.
      i++; // skip opening quote
      let buf = "";
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < input.length) {
          buf += input[i + 1];
          i += 2;
          continue;
        }
        buf += input[i];
        i++;
      }
      value = buf;
      i++; // skip closing quote
    } else {
      const valStart = i;
      while (i < input.length && input[i] !== ",") i++;
      value = input.slice(valStart, i).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Quote a string for embedding inside a `key="value"` HTTP header
 * parameter. Escapes `"` and `\` per RFC 7230.
 */
function quote(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
