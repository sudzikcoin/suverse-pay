import { z } from "zod";

export const OptimizeStrategySchema = z.enum(["cost", "latency", "success_rate"]);
export type OptimizeStrategy = z.infer<typeof OptimizeStrategySchema>;

export const MerchantPolicySchema = z.object({
  optimize: OptimizeStrategySchema.default("cost"),
  fallback: z.boolean().default(true),
  maxAttempts: z.number().int().positive().max(10).default(3),
  maxLatencyMs: z.number().int().positive().optional(),
  providerHint: z.string().optional(),
});

export type MerchantPolicy = z.infer<typeof MerchantPolicySchema>;
export type MerchantPolicyInput = z.input<typeof MerchantPolicySchema>;

export const DEFAULT_MERCHANT_POLICY: MerchantPolicy = MerchantPolicySchema.parse({});
