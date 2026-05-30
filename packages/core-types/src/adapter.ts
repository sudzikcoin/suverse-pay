import { z } from "zod";
import { Caip2Schema } from "./chain.js";
import { ErrorCodeSchema } from "./errors.js";
import { PaymentPayloadSchema, PaymentRequirementsSchema } from "./x402.js";

export const SupportQuerySchema = z.object({
  network: Caip2Schema,
  asset: z.string().min(1),
  scheme: z.string().min(1),
});
export type SupportQuery = z.infer<typeof SupportQuerySchema>;

export const SupportResultSchema = z.object({
  supported: z.boolean(),
  reason: z.string().optional(),
});
export type SupportResult = z.infer<typeof SupportResultSchema>;

export const QuoteRequestSchema = z.object({
  network: Caip2Schema,
  asset: z.string().min(1),
  amount: z.string().min(1),
  scheme: z.string().min(1),
});
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;

export const QuoteSourceSchema = z.enum(["native", "synthetic"]);
export type QuoteSource = z.infer<typeof QuoteSourceSchema>;

export const QuoteResponseSchema = z.object({
  providerId: z.string().min(1),
  network: Caip2Schema,
  asset: z.string().min(1),
  amount: z.string().min(1),
  estimatedFeeUsd: z.string().min(1),
  estimatedLatencyMs: z.number().nonnegative(),
  scheme: z.string().min(1),
  source: QuoteSourceSchema,
});
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;

export const VerifyRequestSchema = z.object({
  paymentPayload: PaymentPayloadSchema,
  paymentRequirements: PaymentRequirementsSchema,
});
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;

export const VerifyResponseSchema = z.object({
  valid: z.boolean(),
  providerId: z.string().min(1),
  payer: z.string().optional(),
  verifiedAt: z.string().datetime(),
  errorCode: ErrorCodeSchema.optional(),
  errorMessage: z.string().optional(),
});
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;

export const SettleRequestSchema = z.object({
  paymentPayload: PaymentPayloadSchema,
  paymentRequirements: PaymentRequirementsSchema,
});
export type SettleRequest = z.infer<typeof SettleRequestSchema>;

export const SettleOptionsSchema = z.object({
  idempotencyKey: z.string().min(1).optional(),
});
export type SettleOptions = z.infer<typeof SettleOptionsSchema>;

export const SettleResponseSchema = z.object({
  settled: z.boolean(),
  providerId: z.string().min(1),
  providerPaymentId: z.string().optional(),
  txHash: z.string().optional(),
  network: Caip2Schema,
  amount: z.string().min(1),
  asset: z.string().min(1),
  payer: z.string().optional(),
  settledAt: z.string().datetime().optional(),
  errorCode: ErrorCodeSchema.optional(),
  errorMessage: z.string().optional(),
});
export type SettleResponse = z.infer<typeof SettleResponseSchema>;

export const ProviderPaymentStatusSchema = z.enum(["pending", "settled", "failed"]);
export type ProviderPaymentStatus = z.infer<typeof ProviderPaymentStatusSchema>;

export const StatusResponseSchema = z.object({
  providerId: z.string().min(1),
  providerPaymentId: z.string().min(1),
  status: ProviderPaymentStatusSchema,
  txHash: z.string().optional(),
  errorCode: ErrorCodeSchema.optional(),
  errorMessage: z.string().optional(),
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

/**
 * Optional context the orchestrator can pass to `getStatus()`. Some
 * providers (cosmos-pay) settle synchronously and have no status
 * endpoint — adapters use these hints to reconstruct status from
 * gateway-side state without taking a DB dependency.
 */
export const GetStatusHintsSchema = z.object({
  txHash: z.string().optional(),
  errorCode: ErrorCodeSchema.optional(),
});
export type GetStatusHints = z.infer<typeof GetStatusHintsSchema>;

export const HealthStateSchema = z.enum(["healthy", "degraded", "down"]);
export type HealthState = z.infer<typeof HealthStateSchema>;

export const HealthStatusSchema = z.object({
  status: HealthStateSchema,
  latencyMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
  checkedAt: z.string().datetime(),
});
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const DiscoveredCapabilitySchema = z.object({
  network: Caip2Schema,
  asset: z.string().min(1),
  scheme: z.string().min(1),
  /**
   * Per-kind extras the adapter wants surfaced via
   * /facilitator/supported. Examples:
   * - Solana: `{ feePayer: "<base58 pubkey>" }`
   * - Cosmos: `{ facilitator: "<grantee bech32>", chainId, decimals, symbol }`
   * - EVM: `{ name: "USD Coin", version: "2" }` (EIP-712 USDC domain)
   * Persisted as `provider_capabilities.extras_json` (JSONB, nullable).
   */
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type DiscoveredCapability = z.infer<typeof DiscoveredCapabilitySchema>;

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;

  supports(req: SupportQuery): Promise<SupportResult>;
  quote(req: QuoteRequest): Promise<QuoteResponse>;
  verify(req: VerifyRequest): Promise<VerifyResponse>;
  settle(req: SettleRequest, opts?: SettleOptions): Promise<SettleResponse>;
  getStatus(providerPaymentId: string, hints?: GetStatusHints): Promise<StatusResponse>;
  healthCheck(): Promise<HealthStatus>;
  discoverCapabilities?(): Promise<DiscoveredCapability[]>;
}
