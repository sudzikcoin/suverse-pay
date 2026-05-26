import { z } from "zod";
import { Caip2Schema } from "./chain.js";

export const PaymentRequirementsSchema = z.object({
  scheme: z.string().min(1),
  network: Caip2Schema,
  maxAmountRequired: z.string().min(1),
  asset: z.string().min(1),
  payTo: z.string().min(1),
  resource: z.string().min(1),
  description: z.string().optional(),
  mimeType: z.string().optional(),
  maxTimeoutSeconds: z.number().int().positive().optional(),
  outputSchema: z.unknown().nullable().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;

export const PaymentPayloadSchema = z.object({
  x402Version: z.number().int().positive(),
  scheme: z.string().min(1),
  network: Caip2Schema,
  payload: z.unknown(),
});

export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;
