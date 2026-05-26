import { z } from "zod";
import { Caip2Schema } from "./chain.js";
import { ErrorCodeSchema } from "./errors.js";

export const PaymentStatusSchema = z.enum(["pending", "settled", "failed"]);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const PaymentAttemptOutcomeSchema = z.enum(["success", "failed", "timeout"]);
export type PaymentAttemptOutcome = z.infer<typeof PaymentAttemptOutcomeSchema>;

export const PaymentAttemptSchema = z.object({
  attemptNumber: z.number().int().positive(),
  providerId: z.string().min(1),
  outcome: PaymentAttemptOutcomeSchema,
  errorCode: ErrorCodeSchema.optional(),
  errorMessage: z.string().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});
export type PaymentAttempt = z.infer<typeof PaymentAttemptSchema>;

export const PaymentSchema = z.object({
  paymentId: z.string().min(1),
  idempotencyKey: z.string().optional(),
  apiKeyId: z.string().min(1),
  status: PaymentStatusSchema,
  network: Caip2Schema,
  asset: z.string().min(1),
  amount: z.string().min(1),
  payer: z.string().optional(),
  recipient: z.string().min(1),
  resource: z.string().optional(),
  finalProviderId: z.string().optional(),
  providerPaymentId: z.string().optional(),
  txHash: z.string().optional(),
  errorCode: ErrorCodeSchema.optional(),
  errorMessage: z.string().optional(),
  createdAt: z.string().datetime(),
  settledAt: z.string().datetime().optional(),
  attempts: z.array(PaymentAttemptSchema),
});
export type Payment = z.infer<typeof PaymentSchema>;
