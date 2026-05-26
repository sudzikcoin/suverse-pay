/**
 * Wire schemas for Coinbase CDP's x402 facilitator HTTP API.
 *
 * Source of truth: the canonical x402 v2 reference TypeScript types in
 * `coinbase/x402` on GitHub — specifically
 * `typescript/packages/core/src/types/facilitator.ts`. CDP's hosted
 * facilitator implements the same schema with optional `invalidMessage`,
 * `errorMessage`, `amount`, and `extensions` fields beyond what the
 * cosmos-pay implementation returns.
 *
 * Endpoints reachable at `${baseUrl}/verify`, `${baseUrl}/settle`,
 * `${baseUrl}/supported` where baseUrl defaults to
 * `https://api.cdp.coinbase.com/platform/v2/x402`.
 *
 * Authentication: every request must carry an `Authorization: Bearer
 * <jwt>` header where the JWT is an EdDSA-signed token built per
 * `https://docs.cdp.coinbase.com/get-started/authentication/jwt-authentication`.
 * The adapter constructs that header internally via `jose`.
 */
import { z } from "zod";

/* --- /supported response --- */

export const CdpSupportedKindSchema = z
  .object({
    x402Version: z.number().int().positive().optional(),
    scheme: z.string(),
    network: z.string(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const CdpSupportedResponseSchema = z
  .object({
    kinds: z.array(CdpSupportedKindSchema),
    extensions: z.array(z.string()).optional(),
    signers: z.record(z.string(), z.array(z.string())).optional(),
  })
  .passthrough();

export type CdpSupportedResponse = z.infer<typeof CdpSupportedResponseSchema>;

/* --- /verify response --- */

export const CdpVerifyResponseSchema = z
  .object({
    isValid: z.boolean(),
    invalidReason: z.string().optional(),
    invalidMessage: z.string().optional(),
    payer: z.string().optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type CdpVerifyResponse = z.infer<typeof CdpVerifyResponseSchema>;

/* --- /settle response --- */

export const CdpSettleResponseSchema = z
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

export type CdpSettleResponse = z.infer<typeof CdpSettleResponseSchema>;
