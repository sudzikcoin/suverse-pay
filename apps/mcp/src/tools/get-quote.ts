import { z } from "zod";

export const GetQuoteInputShape = {
  sessionId: z.string().uuid(),
  asset: z.string().min(1),
  amount: z.string().min(1),
  preferredNetworks: z.array(z.string()).optional(),
  optimize: z.enum(["cost", "latency", "success_rate"]).optional(),
} as const;
export const GetQuoteInput = z.object(GetQuoteInputShape);
export type GetQuoteInput = z.infer<typeof GetQuoteInput>;

export interface GetQuoteResult {
  status: "stub";
  todo: string;
}

export function handleGetQuote(): GetQuoteResult {
  return {
    status: "stub",
    todo: "Phase 2 Sub-task 5 — wrap POST /quote from the suverse-pay REST API.",
  };
}
