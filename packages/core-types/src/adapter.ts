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
});
export type DiscoveredCapability = z.infer<typeof DiscoveredCapabilitySchema>;

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;

  supports(req: SupportQuery): Promise<SupportResult>;
  quote(req: QuoteRequest): Promise<QuoteResponse>;
  verify(req: VerifyRequest): Promise<VerifyResponse>;
  settle(req: SettleRequest, opts?: SettleOptions): Promise<SettleResponse>;
  getStatus(providerPaymentId: string): Promise<StatusResponse>;
  healthCheck(): Promise<HealthStatus>;
  discoverCapabilities?(): Promise<DiscoveredCapability[]>;
}
