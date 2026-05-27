import { z } from "zod";
import { aggregate, type DiscoverySource } from "@suverse-pay/discovery";
import type { SessionStore } from "../session.js";
import { loadSession, safeErrorMessage, type ToolResult } from "./session-helper.js";

export const DiscoverEndpointsInputShape = {
  sessionId: z.string().uuid(),
  query: z.string().optional(),
  network: z.string().optional(),
  asset: z.string().optional(),
  scheme: z.string().optional(),
  payTo: z.string().optional(),
  maxPriceUsd: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
} as const;
export const DiscoverEndpointsInput = z.object(DiscoverEndpointsInputShape);
export type DiscoverEndpointsInput = z.infer<typeof DiscoverEndpointsInput>;

export interface DiscoverEndpointsDeps {
  store: SessionStore;
  /**
   * Discovery sources are constructed once at MCP boot and shared across
   * calls. Constructing them per-call would re-resolve config and lose
   * any future in-memory caching.
   */
  sources: readonly DiscoverySource[];
}

export async function handleDiscoverEndpoints(
  input: DiscoverEndpointsInput,
  deps: DiscoverEndpointsDeps,
): Promise<ToolResult<{ endpoints: unknown[] }>> {
  const lookup = loadSession(deps.store, input.sessionId);
  if (!lookup.ok) return { ok: false, error: lookup.error };

  try {
    const params: Parameters<typeof aggregate>[1] = {};
    if (input.query !== undefined) params.query = input.query;
    if (input.network !== undefined) params.network = input.network;
    if (input.asset !== undefined) params.asset = input.asset;
    if (input.scheme !== undefined) params.scheme = input.scheme;
    if (input.payTo !== undefined) params.payTo = input.payTo;
    if (input.maxPriceUsd !== undefined) params.maxPriceUsd = input.maxPriceUsd;
    if (input.limit !== undefined) params.limit = input.limit;

    const endpoints = await aggregate(deps.sources, params);
    lookup.session.touch();
    return { ok: true, result: { endpoints } };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "discover_endpoints_failed",
        message: safeErrorMessage(err),
      },
    };
  }
}
