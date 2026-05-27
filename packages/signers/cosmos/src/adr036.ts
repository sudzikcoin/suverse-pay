import { toBase64, toUtf8 } from "@cosmjs/encoding";
import type { Authorization } from "./types.js";

/**
 * Recursively sort object keys at every level, return canonical JSON.
 * Matches @cosmjs/amino's internal `sortedJsonStringify` (which is not
 * exported at the package boundary) and Go's `sdk.SortJSON`. Arrays
 * keep order; only object keys are sorted.
 */
function sortedJsonStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
  const out: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    out[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return out;
}

/**
 * Apply Go's default `encoding/json` HTML escaping to string values
 * inside a JSON document: `&` → `&`, `<` → `<`, `>` → `>`.
 * Mirrors @cosmjs/amino's `escapeCharacters` byte-for-byte and matches
 * what `sdk.SortJSON` produces after its inner `json.Marshal`.
 */
function escapeJsonHtmlChars(input: string): string {
  return input
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

/**
 * Canonical (sorted, no whitespace, HTML-escaped) JSON of the
 * Authorization struct. This is the inner payload Keplr's
 * `signArbitrary` would display, base64-wrapped into `data` inside the
 * ADR-036 outer doc.
 */
export function canonicalAuthorizationJson(auth: Authorization): string {
  return escapeJsonHtmlChars(sortedJsonStringify(auth));
}

/**
 * The exact byte sequence the payer signs over. Returns the sorted-doc
 * UTF-8 bytes (NOT the SHA-256 digest); the signing code SHA-256s it
 * before calling `Secp256k1.createSignature(digest, privkey)`.
 *
 * The ADR-036 outer doc mirrors x402-cosmos/facilitator/adr036.go
 * exactly:
 *   {
 *     "account_number": "0",
 *     "chain_id": "",
 *     "fee": { "amount": [], "gas": "0" },
 *     "memo": "",
 *     "msgs": [{
 *       "type": "sign/MsgSignData",
 *       "value": { "data": base64(canonicalAuthorizationJson), "signer": payer }
 *     }],
 *     "sequence": "0"
 *   }
 * `sortedJsonStringify` reorders keys lexicographically; the struct
 * literal order above is purely for readability.
 */
export function adr036Preimage(auth: Authorization, payerAddress: string): Uint8Array {
  const innerJson = canonicalAuthorizationJson(auth);
  const dataB64 = toBase64(toUtf8(innerJson));

  const doc = {
    account_number: "0",
    chain_id: "",
    fee: { amount: [] as unknown[], gas: "0" },
    memo: "",
    msgs: [
      {
        type: "sign/MsgSignData",
        value: { data: dataB64, signer: payerAddress },
      },
    ],
    sequence: "0",
  };

  return toUtf8(escapeJsonHtmlChars(sortedJsonStringify(doc)));
}
