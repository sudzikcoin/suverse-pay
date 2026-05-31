/**
 * Type definitions for Stripe's Machine Payments Protocol (MPP).
 * Phase 4 Block 2 Sub-task 9.
 *
 * MPP is a 402-protocol very close in shape to x402, with two key
 * differences:
 *
 *   1. **Wire format** lives in HTTP headers (`WWW-Authenticate: Payment`
 *      + `Authorization: Payment`) rather than the response body /
 *      x402's `X-PAYMENT` header.
 *   2. **Multi-method/multi-intent matrix** — a single MPP challenge
 *      can carry several `WWW-Authenticate: Payment` lines, one per
 *      `(method, intent)` pair the resource accepts. Methods include
 *      `tempo` (Tempo L1 USDC), `stripe` (fiat via Shared Payment
 *      Tokens), `lightning`, `solana`, `monad`, `stellar`, `redotpay`.
 *      Intents include `charge` (one-shot), `subscription` (recurring),
 *      and `session` (pay-as-you-go).
 *
 * Schema mirrors wevm/mppx's `Challenge` schema verbatim (re-derived
 * here so we don't pull mppx as a runtime dep — adapter stays pure
 * Zod). Source-of-truth links:
 *   - https://mpp.dev/protocol/http-402
 *   - https://github.com/wevm/mppx (src/Challenge.ts)
 *   - https://github.com/tempoxyz/payment-auth-spec
 *
 * **What this adapter ships in Phase 4**: types + capability advertising
 * + the wire-translation primitives (challenge build / credential
 * parse) for the `intent=charge` + `method=tempo|stripe` happy paths.
 * Stripe's MPP API requires merchant onboarding (sk_live/sk_test
 * keys); real settle wiring lands when keys are available — Phase 5.
 *
 * **What is NOT shipped**: a `/mpp/*` HTTP front door, persisted
 * sessions, or the `subscription`/`session` intent logic. The
 * adapter is internally callable today.
 */
import { z } from "zod";

/* --- Method values per the MPP spec --- */
export const MPP_METHODS = [
  "tempo",
  "stripe",
  "lightning",
  "solana",
  "monad",
  "stellar",
  "redotpay",
] as const;
export type MppMethod = (typeof MPP_METHODS)[number];

/* --- Intent values per the MPP spec --- */
export const MPP_INTENTS = ["charge", "subscription", "session"] as const;
export type MppIntent = (typeof MPP_INTENTS)[number];

/**
 * MPP Challenge schema — what the server emits in a
 * `WWW-Authenticate: Payment id="...", realm="...", method="...",
 *  intent="...", request="<base64url JSON>", ...` line.
 *
 * Fields mirror wevm/mppx's `Challenge.Schema`. The `request` field
 * is the method-specific payload — for `tempo charge` it is
 * `{amount, currency, recipient, chainId?}`; the adapter does not
 * enforce a tight shape here because MPP allows arbitrary
 * method-defined fields.
 */
export const MppChallengeSchema = z
  .object({
    /** HMAC-bound challenge identifier the server uses to validate the credential. */
    id: z.string().min(1),
    /** Server realm — typically the hostname. */
    realm: z.string().min(1),
    /** One of MPP_METHODS, but accepted as string for forward-compat. */
    method: z.string().min(1),
    /** One of MPP_INTENTS, but accepted as string for forward-compat. */
    intent: z.string().min(1),
    /** Method-specific request payload (decoded from the base64url `request` parameter). */
    request: z.record(z.string(), z.unknown()),
    /** Optional human-readable description. */
    description: z.string().optional(),
    /** Optional ISO 8601 challenge expiration. */
    expires: z.string().datetime().optional(),
    /** Optional sha-256 digest of the original request body, format `"sha-256=<base64>"`. */
    digest: z
      .string()
      .regex(/^sha-256=/)
      .optional(),
    /** Optional opaque server-side correlation data (clients echo verbatim). */
    opaque: z.string().optional(),
    /** Optional parsed meta map (string -> string). */
    meta: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export type MppChallenge = z.infer<typeof MppChallengeSchema>;

/* --- Credential schema — Authorization: Payment <base64url JSON> --- */

/**
 * MPP credential, the client's response to a 402 challenge. The
 * decoded payload is method-specific; we accept a permissive record
 * here and let per-method verifiers tighten the shape.
 */
export const MppCredentialSchema = z
  .object({
    /** Challenge id this credential answers. */
    challengeId: z.string().min(1),
    /** Method (echoes one of the challenge's offered methods). */
    method: z.string().min(1),
    /** Intent (echoes the matched challenge's intent). */
    intent: z.string().min(1),
    /** Method-specific payload — for tempo charge: `{signature, type: "transaction"|"hash"|"proof"}`. */
    payload: z.record(z.string(), z.unknown()),
    /** Optional opaque field echoed from the challenge. */
    opaque: z.string().optional(),
  })
  .passthrough();

export type MppCredential = z.infer<typeof MppCredentialSchema>;

/* --- Result types --- */

export interface MppCapability {
  /** Method (e.g. `"tempo"`). */
  method: string;
  /** Intent (e.g. `"charge"`). */
  intent: string;
  /** CAIP-2-style network identifier when method is chain-backed. */
  network?: string;
  /** Token / asset identifier when applicable. */
  asset?: string;
}

export interface MppVerifyResult {
  /** True if the credential is well-formed AND the server has confirmed it. */
  valid: boolean;
  /** Payer address / merchant id / Stripe customer id, when verification surfaces it. */
  payer?: string;
  /** ISO 8601 timestamp of verification. */
  verifiedAt: string;
  /** Normalized error code on failure. */
  errorCode?: string;
  /** Human-readable error message. */
  errorMessage?: string;
}

export interface MppSettleResult {
  /** True iff settlement succeeded. */
  settled: boolean;
  /** On-chain tx hash for `tempo` method; Stripe PaymentIntent id for `stripe` method. */
  reference?: string;
  /** Atomic-unit amount actually moved. */
  amount?: string;
  /** Network (CAIP-2) for chain-backed methods; "stripe" for SPT/fiat. */
  network?: string;
  /** Asset (contract address for chain methods; ISO 4217 currency for fiat). */
  asset?: string;
  /** ISO 8601. */
  settledAt: string;
  /** Normalized error code on failure. */
  errorCode?: string;
  /** Human-readable error message. */
  errorMessage?: string;
}

/* --- Wire-encoding helpers --- */

/**
 * Base64url encoding/decoding — MPP uses URL-safe base64 with no
 * padding for both the challenge `request` parameter and the
 * `Authorization: Payment` credential.
 */
export function base64urlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

export function base64urlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  // Buffer accepts unpadded base64 silently, but we restore padding
  // for clarity and round-trip safety.
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64").toString("utf8");
}
