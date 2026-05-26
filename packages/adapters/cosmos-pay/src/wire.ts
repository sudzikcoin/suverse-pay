/**
 * Wire schemas for the sudzikcoin/cosmos-pay Go facilitator HTTP API.
 *
 * These mirror the JSON tags in `facilitator/types.go` and the handler
 * registrations in `facilitator/cmd/main.go` of the cosmos-pay repo.
 * If cosmos-pay changes its wire format, this file is the only place
 * in suverse-pay that needs to follow.
 *
 * Reference (lines refer to the cosmos-pay repo, commit visible at
 * /home/govhub/x402-cosmos/ on this machine):
 *
 * - cmd/main.go:46-51   — endpoint registration
 * - types.go:69-94      — VerifyRequest / VerifyResponse / SettleResponse
 * - types.go:96-106     — ErrorReason constants (8 spec codes)
 * - cmd/main.go:87,67   — "bad_request" sent on malformed JSON (/settle)
 */
import { z } from "zod";

/* --- Outgoing: VerifyRequest body (also used by /settle, type alias in Go) --- */

export const CosmosPayAuthorizationSchema = z.object({
  from: z.string(),
  to: z.string(),
  denom: z.string(),
  amount: z.string(),
  nonce: z.string(),
  validAfter: z.number().int().nonnegative(),
  validBefore: z.number().int().nonnegative(),
  resource: z.string(),
  chainId: z.string(),
});

export const CosmosPayPayloadSchema = z.object({
  from: z.string(),
  publicKey: z.string(),
  signature: z.string(),
  authorization: CosmosPayAuthorizationSchema,
});

export const CosmosPayPaymentPayloadSchema = z.object({
  x402Version: z.number().int().positive(),
  scheme: z.string(),
  network: z.string(),
  payload: CosmosPayPayloadSchema,
});

export const CosmosPayRequirementsExtraSchema = z
  .object({
    facilitator: z.string(),
    chainId: z.string(),
    decimals: z.number().int().nonnegative().optional(),
    symbol: z.string().optional(),
  })
  .passthrough();

export const CosmosPayPaymentRequirementsSchema = z
  .object({
    scheme: z.string(),
    network: z.string(),
    maxAmountRequired: z.string(),
    asset: z.string(),
    payTo: z.string(),
    resource: z.string(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    maxTimeoutSeconds: z.number().int().nonnegative(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    extra: CosmosPayRequirementsExtraSchema,
  })
  .passthrough();

export const CosmosPayVerifyRequestSchema = z.object({
  x402Version: z.number().int().positive(),
  paymentPayload: CosmosPayPaymentPayloadSchema,
  paymentRequirements: CosmosPayPaymentRequirementsSchema,
});

export type CosmosPayVerifyRequest = z.infer<typeof CosmosPayVerifyRequestSchema>;
export type CosmosPaySettleRequest = CosmosPayVerifyRequest; // Go: `type SettleRequest = VerifyRequest`

/* --- Incoming: response bodies --- */

export const CosmosPayVerifyResponseSchema = z.object({
  isValid: z.boolean(),
  invalidReason: z.string().optional(),
  payer: z.string().optional(),
});
export type CosmosPayVerifyResponse = z.infer<typeof CosmosPayVerifyResponseSchema>;

export const CosmosPaySettleResponseSchema = z.object({
  success: z.boolean(),
  errorReason: z.string().optional(),
  transaction: z.string().optional(),
  network: z.string().optional(),
  payer: z.string().optional(),
});
export type CosmosPaySettleResponse = z.infer<typeof CosmosPaySettleResponseSchema>;

export const CosmosPaySupportedPairSchema = z.object({
  scheme: z.string(),
  network: z.string(),
});

export const CosmosPaySupportedResponseSchema = z.object({
  kinds: z.array(CosmosPaySupportedPairSchema),
});
export type CosmosPaySupportedResponse = z.infer<typeof CosmosPaySupportedResponseSchema>;
