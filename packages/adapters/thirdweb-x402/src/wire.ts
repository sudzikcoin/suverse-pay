/**
 * Wire schemas for Thirdweb's Nexus x402 facilitator HTTP API at
 * `https://nexus-api.thirdweb.com`.
 *
 * Probed live 2026-05-29 against the public surface:
 *   - `GET /supported` → returns `{kinds: [...]}` where every entry
 *     carries `x402Version: 1` (even though `network` uses CAIP-2
 *     identifiers, which the spec ties to v2). The Thirdweb SDK's own
 *     Zod schema accepts `z.union([z.literal(1), z.literal(2)])` so we
 *     mirror that here — we accept either and rely on the static
 *     capability list to constrain what we actually transact.
 *   - `GET /health` → returns `{status, timestamp, database}`. Open.
 *   - `POST /verify` / `POST /settle` → require `x-nexus-key` header.
 *     Wire shape is canonical x402 v2: `{x402Version, paymentPayload,
 *     paymentRequirements}`. Response shapes mirror Coinbase CDP /
 *     PayAI: `isValid + invalidReason` for verify, `success +
 *     errorReason + transaction + ...` for settle. Plus Thirdweb-
 *     specific helper fields (`fundWalletLink`, `allowance`, `balance`)
 *     that are not part of the spec but we surface for diagnostics.
 *
 * `/supported` advertises a `defaultAsset` with on-chain address,
 * decimals, and EIP-712 domain metadata (`name`/`version`/`primaryType`).
 * `primaryType` is either `"TransferWithAuthorization"` (EIP-3009 path,
 * what our `signer-evm` produces) or `"Permit"` (EIP-2612 — we don't
 * sign these today and skip those networks at capability registration).
 */
import { z } from "zod";

/* --- /supported response --- */

export const ThirdwebSupportedAssetSchema = z
  .object({
    address: z.string(),
    decimals: z.number(),
    eip712: z.object({
      name: z.string(),
      version: z.string(),
      primaryType: z.enum(["TransferWithAuthorization", "Permit"]),
    }),
  })
  .passthrough();

export const ThirdwebSupportedExtraSchema = z
  .object({
    defaultAsset: ThirdwebSupportedAssetSchema.optional(),
    supportedAssets: z.array(ThirdwebSupportedAssetSchema).optional(),
  })
  .passthrough();

export const ThirdwebSupportedKindSchema = z
  .object({
    x402Version: z.number().int().positive(),
    scheme: z.string(),
    network: z.string(),
    extra: ThirdwebSupportedExtraSchema.optional(),
  })
  .passthrough();

export const ThirdwebSupportedResponseSchema = z
  .object({
    kinds: z.array(ThirdwebSupportedKindSchema),
  })
  .passthrough();

export type ThirdwebSupportedAsset = z.infer<typeof ThirdwebSupportedAssetSchema>;
export type ThirdwebSupportedKind = z.infer<typeof ThirdwebSupportedKindSchema>;
export type ThirdwebSupportedResponse = z.infer<typeof ThirdwebSupportedResponseSchema>;

/* --- /verify response --- */

export const ThirdwebVerifyResponseSchema = z
  .object({
    isValid: z.boolean(),
    invalidReason: z.string().optional(),
    invalidMessage: z.string().optional(),
    errorMessage: z.string().optional(),
    payer: z.string().optional(),
    fundWalletLink: z.string().optional(),
    allowance: z.string().optional(),
    balance: z.string().optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type ThirdwebVerifyResponse = z.infer<typeof ThirdwebVerifyResponseSchema>;

/* --- /settle response --- */

export const ThirdwebSettleResponseSchema = z
  .object({
    success: z.boolean(),
    errorReason: z.string().optional(),
    errorMessage: z.string().optional(),
    invalidReason: z.string().optional(),
    payer: z.string().optional(),
    transaction: z.string().optional(),
    network: z.string().optional(),
    amount: z.string().optional(),
    fundWalletLink: z.string().optional(),
    allowance: z.string().optional(),
    balance: z.string().optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type ThirdwebSettleResponse = z.infer<typeof ThirdwebSettleResponseSchema>;

/* --- /health response --- */

export const ThirdwebHealthResponseSchema = z
  .object({
    status: z.string(),
    timestamp: z.string().optional(),
    database: z.string().optional(),
  })
  .passthrough();

export type ThirdwebHealthResponse = z.infer<typeof ThirdwebHealthResponseSchema>;
