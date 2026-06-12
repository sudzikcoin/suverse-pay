/**
 * Discovery-probe classification for paid endpoints with a required
 * input field.
 *
 * Catalog crawlers (e.g. the CDP Bazaar crawler) probe endpoints with
 * EMPTY or placeholder bodies — they are schema-blind by design: the
 * whole point of the probe is to read the 402 challenge, which carries
 * the price, description and `extensions.bazaar` schema. If we 422
 * such probes BEFORE the challenge, the endpoint never exposes its
 * metadata and stays invisible in discovery surfaces, despite being
 * live (morning-report 20260612 — crawler 0x9CC42f never saw the 402
 * on wallet-reputation / token-check).
 *
 * The fix is a three-way split, NOT a removal of the pre-payment gate:
 *
 *   empty / missing / placeholder field → DISCOVERY: serve the 402
 *     challenge (price + bazaar extension + machine-readable
 *     `input_schema`). An unpaid probe learns the contract; a paid
 *     request with such a body is still stopped by the handler's
 *     preflight BEFORE settlement, so the anti-"pay for garbage"
 *     guarantee is intact.
 *   present + valid → normal flow (402 challenge, then settle+serve).
 *   present + invalid base58 → 422 before the challenge, never
 *     settles. The caller supplied real-but-wrong input; charging
 *     them would be selling garbage, and challenging them would
 *     invite paying for garbage.
 */

export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Values that schema-blind tools conventionally substitute for "a
 * string goes here". Matched case-insensitively after trimming.
 * Checked BEFORE the base58 test on purpose: some placeholders (e.g.
 * "YourWalletAddressHere1234567890123456") are accidentally valid
 * base58 and must still classify as discovery, not as a real wallet.
 */
const PLACEHOLDER_WORDS = new Set([
  "string",
  "null",
  "undefined",
  "none",
  "nil",
  "example",
  "test",
  "demo",
  "sample",
  "placeholder",
  "value",
  "wallet",
  "token",
  "address",
  "mint",
  "solana",
  "base58",
  "abc",
  "xyz",
  "foo",
  "bar",
  "...",
  "redacted",
  "changeme",
  "tbd",
  "todo",
]);

export function isPlaceholderValue(raw: string): boolean {
  const v = raw.trim();
  if (v.length === 0) return true;
  const lower = v.toLowerCase();
  if (PLACEHOLDER_WORDS.has(lower)) return true;
  // YOUR_WALLET / your-address-here / YourWalletAddressHere…
  if (/^your[_\-A-Z]/i.test(v) || lower.startsWith("your ")) return true;
  // Bracketed schema tokens: <solana mint>, {wallet}, [address], ${W}.
  if (/^<.*>$/s.test(v)) return true;
  if (/^\$?\{.*\}$/s.test(v)) return true;
  if (/^\[.*\]$/s.test(v)) return true;
  // xxxxxxxx… filler.
  if (/^x{3,}$/i.test(v)) return true;
  return false;
}

export type RequiredBase58Classification =
  /** No body / no usable field / placeholder — serve the 402 challenge. */
  | { kind: "discovery" }
  /** Body present but not parseable as JSON at all. */
  | { kind: "invalid_json" }
  /** JSON parsed but the top level is not an object (array, scalar). */
  | { kind: "malformed" }
  /** Field present as a real (non-placeholder) string failing base58. */
  | { kind: "invalid_value"; value: string }
  | { kind: "valid"; value: string };

/**
 * Classify a request body against a single required base58 field.
 * Shared by wallet-reputation (`wallet`) and token-check (`token`).
 */
export function classifyRequiredBase58Field(
  body: Buffer | null,
  field: string,
): RequiredBase58Classification {
  if (!body || body.length === 0 || body.toString("utf8").trim() === "") {
    return { kind: "discovery" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { kind: "invalid_json" };
  }
  if (parsed === null) return { kind: "discovery" };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "malformed" };
  }
  const value = (parsed as Record<string, unknown>)[field];
  // Missing or non-string (a type-blind probe filling 0/false/null):
  // nothing usable was supplied — discovery, not a malformed attempt.
  if (typeof value !== "string") return { kind: "discovery" };
  if (isPlaceholderValue(value)) return { kind: "discovery" };
  if (!BASE58_RE.test(value)) return { kind: "invalid_value", value };
  return { kind: "valid", value };
}

/**
 * Machine-readable input contract attached to the 402 challenge body
 * (top-level `input_schema`) for internal handlers that require one.
 * Lets schema-aware agents self-correct instead of paying for a call
 * with a body the handler will reject (an agent burned $0.03 on a 415
 * for a malformed body on 2026-06-08 — this is the antidote).
 */
export interface InternalHandlerInputSchema {
  method: string;
  content_type: string;
  body: {
    type: "object";
    required: string[];
    properties: Record<
      string,
      { type: string; description: string; pattern?: string }
    >;
  };
  example: Record<string, unknown>;
}
