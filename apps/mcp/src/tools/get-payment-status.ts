import { z } from "zod";
import type { GatewayClient } from "../gateway-client.js";
import { GatewayError } from "../gateway-client.js";
import type { SessionStore } from "../session.js";
import { loadSession, safeErrorMessage, type ToolResult } from "./session-helper.js";

export const GetPaymentStatusInputShape = {
  sessionId: z.string().uuid(),
  paymentId: z
    .string()
    .min(1)
    .max(200)
    .describe("Payment ID returned from pay_and_call's /settle response."),
} as const;
export const GetPaymentStatusInput = z.object(GetPaymentStatusInputShape);
export type GetPaymentStatusInput = z.infer<typeof GetPaymentStatusInput>;

export interface GetPaymentStatusDeps {
  store: SessionStore;
  gateway: GatewayClient;
}

export async function handleGetPaymentStatus(
  input: GetPaymentStatusInput,
  deps: GetPaymentStatusDeps,
): Promise<ToolResult<unknown>> {
  const lookup = loadSession(deps.store, input.sessionId);
  if (!lookup.ok) return { ok: false, error: lookup.error };

  // Defensive: don't pass anything to the gateway path that could
  // break out of the /payments/:id segment. encodeURIComponent in the
  // client handles this, but we still want a fast 400 for obviously
  // garbage ids.
  if (!/^[A-Za-z0-9_\-.]+$/.test(input.paymentId)) {
    return {
      ok: false,
      error: {
        code: "invalid_payment_id",
        message: "paymentId must contain only alphanumerics, '_', '-', and '.'",
      },
    };
  }

  try {
    const result = await deps.gateway.getPayment(input.paymentId);
    lookup.session.touch();
    return { ok: true, result };
  } catch (err) {
    if (err instanceof GatewayError) {
      return {
        ok: false,
        error: { code: err.code ?? "gateway_error", message: err.message },
      };
    }
    return {
      ok: false,
      error: { code: "get_payment_status_failed", message: safeErrorMessage(err) },
    };
  }
}
