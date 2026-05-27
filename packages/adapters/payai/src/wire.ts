/**
 * Wire schemas for PayAI's x402 facilitator HTTP API at
 * `https://facilitator.payai.network`.
 *
 * PayAI's response shapes for /verify, /settle, /supported are
 * essentially the canonical x402 v2 facilitator contract — same
 * shape Coinbase CDP uses. We re-declare them locally so any future
 * provider-specific drift (extra fields, etc.) is captured here
 * rather than shared across adapters.
 *
 * Observed quirks from live /supported (2026-05-28):
 *   - PayAI advertises BOTH x402 v1 (legacy short names like "solana")
 *     AND v2 (CAIP-2 like "solana:5eykt4...") entries simultaneously.
 *     The adapter targets v2 only and ignores v1 entries during
 *     discovery to avoid duplicate capabilities.
 *   - Solana entries include `extra.feePayer` advertising PayAI's
 *     fee-payer address (the facilitator pubkey clients sign against).
 *     We expose it via `supportedFeePayer()` for callers that need it.
 */
import { z } from "zod";

/* --- /supported response --- */

export const PayAiSupportedKindSchema = z
  .object({
    x402Version: z.number().int().positive(),
    scheme: z.string(),
    network: z.string(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const PayAiSupportedResponseSchema = z
  .object({
    kinds: z.array(PayAiSupportedKindSchema),
    extensions: z.array(z.string()).optional(),
    signers: z.record(z.string(), z.array(z.string())).optional(),
  })
  .passthrough();

export type PayAiSupportedResponse = z.infer<typeof PayAiSupportedResponseSchema>;
export type PayAiSupportedKind = z.infer<typeof PayAiSupportedKindSchema>;

/* --- /verify response --- */

export const PayAiVerifyResponseSchema = z
  .object({
    isValid: z.boolean(),
    invalidReason: z.string().optional(),
    invalidMessage: z.string().optional(),
    payer: z.string().optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type PayAiVerifyResponse = z.infer<typeof PayAiVerifyResponseSchema>;

/* --- /settle response --- */

export const PayAiSettleResponseSchema = z
  .object({
    success: z.boolean(),
    errorReason: z.string().optional(),
    errorMessage: z.string().optional(),
    payer: z.string().optional(),
    transaction: z.string().optional(),
    network: z.string().optional(),
    amount: z.string().optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type PayAiSettleResponse = z.infer<typeof PayAiSettleResponseSchema>;
