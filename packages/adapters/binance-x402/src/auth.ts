import { createHmac, randomBytes } from "node:crypto";

/**
 * Binance Pay HMAC-SHA512 request signing — the canonical auth scheme
 * Binance uses across the merchant API surface that hosts Binance
 * x402.
 *
 * Per `binance/binance-pay-signature-examples` (Python `signature.py`):
 *
 *   payload_to_sign = `${timestamp}\n${nonce}\n${JSON.stringify(body)}\n`
 *   signature = HMAC_SHA512(secret, payload_to_sign).toUpperCase()
 *
 * Headers sent on every signed request:
 *   - Content-Type: application/json
 *   - BinancePay-Timestamp: <unix milliseconds>
 *   - BinancePay-Nonce: <random 32-char alphanumeric>
 *   - BinancePay-Certificate-SN: <api key id>
 *   - BinancePay-Signature: <hex, uppercase>
 *
 * Idempotency-Key (the cross-spec x402 header) is also emitted when
 * the caller passes one — Binance's docs don't yet mention it but
 * the header is harmless if ignored.
 */

/**
 * Plain string map so the result is directly assignable to fetch
 * `headers: Record<string, string>`. (A more specific typed object
 * would require an index signature.)
 */
export type BinanceAuthHeaders = Record<string, string>;

const NONCE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * 32 alphanumeric characters per Binance Pay's nonce convention.
 * Their Python example uses uuid4 minus dashes (also 32 chars); we
 * use a CSPRNG-backed alphanumeric for the same length, same charset.
 */
function generateNonce(): string {
  const bytes = randomBytes(32);
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += NONCE_CHARS[bytes[i]! % NONCE_CHARS.length];
  }
  return out;
}

export interface BuildAuthHeadersInput {
  apiKeyId: string;
  apiSecret: string;
  /** JSON-serialized request body (string), or empty string for GETs. */
  bodyJson: string;
  /** Optional fixed timestamp for tests. */
  timestampMs?: number;
  /** Optional fixed nonce for tests. */
  nonce?: string;
}

export function buildBinanceAuthHeaders(
  input: BuildAuthHeadersInput,
): BinanceAuthHeaders {
  const timestamp = (input.timestampMs ?? Date.now()).toString();
  const nonce = input.nonce ?? generateNonce();
  const payloadToSign = `${timestamp}\n${nonce}\n${input.bodyJson}\n`;
  const signature = createHmac("sha512", input.apiSecret)
    .update(payloadToSign, "utf8")
    .digest("hex")
    .toUpperCase();
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "BinancePay-Timestamp": timestamp,
    "BinancePay-Nonce": nonce,
    "BinancePay-Certificate-SN": input.apiKeyId,
    "BinancePay-Signature": signature,
  };
}
