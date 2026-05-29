/**
 * Wire schemas for t402-io's hosted facilitator at
 * `https://facilitator.t402.io`. Phase 4 Block 2 Sub-task 10.
 *
 * t402 is essentially a clean fork of x402 — same `kinds: [...]`
 * shape on /supported, same `{paymentPayload, paymentRequirements}`
 * body for verify/settle — with one renaming: `t402Version` replaces
 * `x402Version` everywhere on the wire. The adapter handles that
 * translation so the orchestrator can treat t402-io as another
 * FacilitatorAdapter without speaking t402.
 *
 * Probed live 2026-05-29:
 *   - `GET /supported` → 200, vanilla `{kinds: [...]}` with 77
 *     entries across 11 namespaces. Open, no auth required.
 *   - `GET /health` → 200, `{"status":"healthy","version":"dev"}`.
 *     The `"dev"` version string is a maturity flag — t402-io is
 *     not yet production-versioned. Documented in README.
 *   - `POST /verify` and `POST /settle` → require `X-API-Key`
 *     header or `Authorization: Bearer <key>`. Returns 401
 *     "unauthorized" with body `{"error":"unauthorized","message":
 *     "API key required..."}` when absent. No public signup flow
 *     discovered in the repo as of 2026-05-29.
 *
 * Schemes the facilitator advertises (live): `exact`, `exact-direct`,
 * `exact-legacy`, `upto`. `exact` matches x402's canonical EIP-3009
 * path (verified via examples/typescript/facilitator/README.md from
 * the t402-io monorepo — the wire body is identical to x402 with
 * the version-field rename).
 */
import { z } from "zod";

/* --- /supported response --- */

export const T402SupportedKindSchema = z
  .object({
    /** Renamed from x402Version → t402Version. Value is 2 in the live response. */
    t402Version: z.number().int().positive(),
    scheme: z.string(),
    network: z.string(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const T402SupportedResponseSchema = z
  .object({
    kinds: z.array(T402SupportedKindSchema),
    extensions: z.array(z.string()).optional(),
    signers: z.record(z.string(), z.array(z.string())).optional(),
  })
  .passthrough();

export type T402SupportedKind = z.infer<typeof T402SupportedKindSchema>;
export type T402SupportedResponse = z.infer<typeof T402SupportedResponseSchema>;

/* --- /verify response --- */

export const T402VerifyResponseSchema = z
  .object({
    isValid: z.boolean(),
    invalidReason: z.string().optional(),
    invalidMessage: z.string().optional(),
    errorMessage: z.string().optional(),
    payer: z.string().optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type T402VerifyResponse = z.infer<typeof T402VerifyResponseSchema>;

/* --- /settle response --- */

export const T402SettleResponseSchema = z
  .object({
    success: z.boolean(),
    errorReason: z.string().optional(),
    errorMessage: z.string().optional(),
    invalidReason: z.string().optional(),
    payer: z.string().optional(),
    transaction: z.string().optional(),
    network: z.string().optional(),
    amount: z.string().optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type T402SettleResponse = z.infer<typeof T402SettleResponseSchema>;

/* --- /health response --- */

export const T402HealthResponseSchema = z
  .object({
    status: z.string(),
    version: z.string().optional(),
  })
  .passthrough();

export type T402HealthResponse = z.infer<typeof T402HealthResponseSchema>;
