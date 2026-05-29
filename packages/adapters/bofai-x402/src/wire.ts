/**
 * Wire schemas for BofAI's open x402 facilitator at
 * `https://facilitator.bankofai.io`. Phase 4 Block 2 Sub-task 8.
 *
 * Probed live 2026-05-29:
 *   - `GET /supported` → 200, vanilla x402 v2 `{kinds: [...]}`.
 *     Advertises 10 entries: tron:mainnet × {exact, exact_permit,
 *     exact_gasfree}, tron:nile × same three, eip155:56 × {exact,
 *     exact_permit}, eip155:97 × {exact, exact_permit}. GasFree is
 *     TRON-only.
 *   - `GET /health` → 200 `{"status":"ok"}`.
 *   - `POST /verify` and `POST /settle` → require body
 *     `{paymentPayload, paymentRequirements}` (422 on missing fields).
 *     Open — no auth header required (per BofAI CHANGELOG:
 *     "clients no longer need API keys or secrets" after the v0.6.0
 *     proxy change).
 *
 * Sources: BofAI/x402 specs/protocol.md, specs/config.md,
 * specs/schemes/{exact,exact-permit,exact-gasfree}.md (cloned
 * 2026-05-29).
 */
import { z } from "zod";

/* --- /supported response --- */

export const BofaiSupportedKindSchema = z
  .object({
    x402Version: z.number().int().positive(),
    scheme: z.string(),
    network: z.string(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const BofaiSupportedResponseSchema = z
  .object({
    kinds: z.array(BofaiSupportedKindSchema),
  })
  .passthrough();

export type BofaiSupportedKind = z.infer<typeof BofaiSupportedKindSchema>;
export type BofaiSupportedResponse = z.infer<typeof BofaiSupportedResponseSchema>;

/* --- /verify response (canonical x402 v2 facilitator shape) --- */

export const BofaiVerifyResponseSchema = z
  .object({
    isValid: z.boolean(),
    invalidReason: z.string().optional(),
    invalidMessage: z.string().optional(),
    errorMessage: z.string().optional(),
    payer: z.string().optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type BofaiVerifyResponse = z.infer<typeof BofaiVerifyResponseSchema>;

/* --- /settle response --- */

export const BofaiSettleResponseSchema = z
  .object({
    success: z.boolean(),
    errorReason: z.string().optional(),
    errorMessage: z.string().optional(),
    invalidReason: z.string().optional(),
    payer: z.string().optional(),
    // BofAI's TRON settles return a 64-char hex tx id (no 0x prefix);
    // BSC settles return the standard 0x-prefixed EVM hash. Both
    // surface here.
    transaction: z.string().optional(),
    network: z.string().optional(),
    amount: z.string().optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type BofaiSettleResponse = z.infer<typeof BofaiSettleResponseSchema>;
