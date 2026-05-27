import { z } from "zod";

export const GetPaymentStatusInputShape = {
  paymentId: z.string().min(1),
} as const;
export const GetPaymentStatusInput = z.object(GetPaymentStatusInputShape);
export type GetPaymentStatusInput = z.infer<typeof GetPaymentStatusInput>;

export interface GetPaymentStatusResult {
  status: "stub";
  todo: string;
}

export function handleGetPaymentStatus(): GetPaymentStatusResult {
  return {
    status: "stub",
    todo:
      "Phase 2 Sub-task 5 — wrap GET /payments/:id from the suverse-pay REST API.",
  };
}
