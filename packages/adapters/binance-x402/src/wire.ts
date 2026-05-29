/**
 * Wire schemas for Binance's x402 facilitator. Phase 4 Block 2
 * Sub-task 7.
 *
 * Binance x402 is a Binance Pay product launched 2026-05-19 on BNB
 * Chain. As of 2026-05-29 the facilitator endpoint is behind merchant
 * onboarding (Binance Pay Certificate-SN required); the public
 * landing page (x402.binance.com, www.binance.com/en/x402) is gated
 * behind CloudFront WAF and we could not probe `/supported` without
 * credentials. Schemas here mirror the canonical x402 v2 facilitator
 * contract — same shape PayAI + Thirdweb use, which Binance's
 * announcement implicitly endorses by listing `eip3009`,
 * `permit2-exact`, `permit2-upto` as supported authorization methods
 * (all standard x402 schemes).
 *
 * If Binance's production wire format turns out to differ from
 * canonical x402 v2 once we get merchant access, capture the
 * deviation here (similar to how the CDP adapter handles their
 * envelope quirk).
 *
 * Binance Pay auth (per `binance/binance-pay-signature-examples`):
 *   - Header `BinancePay-Timestamp: <unix milliseconds>`
 *   - Header `BinancePay-Nonce: <random 32 alnum>`
 *   - Header `BinancePay-Certificate-SN: <api key id>`
 *   - Header `BinancePay-Signature: HMAC_SHA512(secret,
 *       `${timestamp}\n${nonce}\n${JSON.stringify(payload)}\n`).toUpperCase()`
 *   - `Content-Type: application/json`
 * The adapter computes these on each verify/settle call.
 */
import { z } from "zod";

/* --- /supported response (assumed canonical x402 v2 shape) --- */

export const BinanceSupportedAssetSchema = z
  .object({
    address: z.string(),
    decimals: z.number(),
    eip712: z
      .object({
        name: z.string(),
        version: z.string(),
        primaryType: z.string(),
      })
      .optional(),
  })
  .passthrough();

export const BinanceSupportedKindSchema = z
  .object({
    x402Version: z.number().int().positive(),
    scheme: z.string(),
    network: z.string(),
    extra: z
      .object({
        defaultAsset: BinanceSupportedAssetSchema.optional(),
        supportedAssets: z.array(BinanceSupportedAssetSchema).optional(),
        assetTransferMethod: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const BinanceSupportedResponseSchema = z
  .object({
    kinds: z.array(BinanceSupportedKindSchema),
  })
  .passthrough();

export type BinanceSupportedAsset = z.infer<typeof BinanceSupportedAssetSchema>;
export type BinanceSupportedKind = z.infer<typeof BinanceSupportedKindSchema>;
export type BinanceSupportedResponse = z.infer<typeof BinanceSupportedResponseSchema>;

/* --- /verify response --- */

export const BinanceVerifyResponseSchema = z
  .object({
    isValid: z.boolean(),
    invalidReason: z.string().optional(),
    invalidMessage: z.string().optional(),
    errorMessage: z.string().optional(),
    payer: z.string().optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type BinanceVerifyResponse = z.infer<typeof BinanceVerifyResponseSchema>;

/* --- /settle response --- */

export const BinanceSettleResponseSchema = z
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

export type BinanceSettleResponse = z.infer<typeof BinanceSettleResponseSchema>;
