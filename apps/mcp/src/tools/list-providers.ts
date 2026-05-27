import { z } from "zod";
import type { GatewayClient } from "../gateway-client.js";
import { GatewayError } from "../gateway-client.js";
import type { SessionStore } from "../session.js";
import { loadSession, safeErrorMessage, type ToolResult } from "./session-helper.js";

export const ListProvidersInputShape = {
  sessionId: z.string().uuid(),
} as const;
export const ListProvidersInput = z.object(ListProvidersInputShape);
export type ListProvidersInput = z.infer<typeof ListProvidersInput>;

export interface ListProvidersDeps {
  store: SessionStore;
  gateway: GatewayClient;
}

export async function handleListProviders(
  input: ListProvidersInput,
  deps: ListProvidersDeps,
): Promise<ToolResult<unknown>> {
  const lookup = loadSession(deps.store, input.sessionId);
  if (!lookup.ok) return { ok: false, error: lookup.error };
  try {
    const result = await deps.gateway.getProviders();
    lookup.session.touch();
    return { ok: true, result };
  } catch (err) {
    if (err instanceof GatewayError) {
      return {
        ok: false,
        error: {
          code: err.code ?? "gateway_error",
          message: err.message,
        },
      };
    }
    return {
      ok: false,
      error: { code: "list_providers_failed", message: safeErrorMessage(err) },
    };
  }
}
