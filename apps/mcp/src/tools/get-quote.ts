import { z } from "zod";
import type { GatewayClient } from "../gateway-client.js";
import { GatewayError } from "../gateway-client.js";
import { isCosmosNetwork } from "../networks.js";
import type { SessionStore } from "../session.js";
import { loadSession, safeErrorMessage, type ToolResult } from "./session-helper.js";

export const GetQuoteInputShape = {
  sessionId: z.string().uuid(),
  asset: z.string().min(1).describe("Token contract address (EVM) or denom (Cosmos)."),
  amount: z.string().min(1).describe("Atomic-unit amount (e.g., '1000000' for 1 USDC)."),
  scheme: z
    .string()
    .min(1)
    .describe("x402 scheme — e.g., 'exact' for EVM EIP-3009 or 'exact_cosmos_authz' for Cosmos."),
  preferredNetworks: z
    .array(z.string())
    .min(1)
    .describe(
      "CAIP-2 networks to quote against. Each must be a network the session " +
        "was initialized for (otherwise the quote can't be paid).",
    ),
  optimize: z.enum(["cost", "latency", "success_rate"]).optional(),
} as const;
export const GetQuoteInput = z.object(GetQuoteInputShape);
export type GetQuoteInput = z.infer<typeof GetQuoteInput>;

export interface GetQuoteDeps {
  store: SessionStore;
  gateway: GatewayClient;
}

export async function handleGetQuote(
  input: GetQuoteInput,
  deps: GetQuoteDeps,
): Promise<ToolResult<unknown>> {
  const lookup = loadSession(deps.store, input.sessionId);
  if (!lookup.ok) return { ok: false, error: lookup.error };

  // Filter requested networks down to the ones this session can sign for.
  // If the agent asks for a network outside the session's capability, we
  // reject — quoting a network we can't pay would be misleading.
  const sessionNets = new Set(lookup.session.networks);
  const outOfScope = input.preferredNetworks.filter((n) => !sessionNets.has(n));
  if (outOfScope.length > 0) {
    return {
      ok: false,
      error: {
        code: "network_not_in_session",
        message:
          `network(s) not in this session: ${outOfScope.join(", ")}. ` +
          `Session is configured for: ${[...sessionNets].join(", ")}. ` +
          `Re-init the session with the network you need.`,
      },
    };
  }

  // Heuristic sanity check: scheme name vs network family. Saves a
  // round-trip when the agent obviously mismatched scheme to network.
  for (const network of input.preferredNetworks) {
    const isCosmos = isCosmosNetwork(network);
    const isCosmosScheme = input.scheme.includes("cosmos");
    if (isCosmos !== isCosmosScheme) {
      return {
        ok: false,
        error: {
          code: "scheme_network_mismatch",
          message:
            `scheme '${input.scheme}' does not match network family of ${network}. ` +
            `Cosmos networks need a *_cosmos_* scheme; EVM networks use 'exact'.`,
        },
      };
    }
  }

  try {
    const body: Parameters<GatewayClient["getQuote"]>[0] = {
      asset: input.asset,
      amount: input.amount,
      preferredNetworks: [...input.preferredNetworks],
      scheme: input.scheme,
    };
    if (input.optimize !== undefined) body.policy = { optimize: input.optimize };

    const result = await deps.gateway.getQuote(body);
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
      error: { code: "get_quote_failed", message: safeErrorMessage(err) },
    };
  }
}
