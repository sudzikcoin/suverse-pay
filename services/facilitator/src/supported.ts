import type { ProviderRegistry } from "@suverse-pay/orchestrator";
import { getRoutingPriority, ROUTING_CONFIG } from "./routing-config.js";

export interface FacilitatorSupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
}

export interface FacilitatorSupportedResponse {
  /** x402 v2 facilitator spec: `kinds` array. */
  kinds: FacilitatorSupportedKind[];
  /** Extensions slot per spec — empty for v0.3.0. */
  extensions: string[];
  /**
   * Map of CAIP-2 patterns → public signer addresses. v0.3.0 returns
   * an empty object; the gateway doesn't expose a signer pubkey of
   * its own because settlement is delegated to the under-the-hood
   * facilitator (which has its own signer key).
   */
  signers: Record<string, string[]>;
}

const PROTOCOL_VERSION = 2;

/**
 * Build the /facilitator/supported response.
 *
 * Pulls the static routing config (which encodes "what we advertise
 * to resource servers") and intersects it with the registry of
 * currently-registered, enabled adapters. Routes whose backing
 * adapters aren't registered are dropped — we don't advertise
 * capabilities we can't actually serve.
 *
 * The aggregated set is per-(scheme, network); `asset` is NOT in the
 * spec's /supported response shape (x402 v2 §7.3). Capability
 * discovery for assets happens via the adapter-level /providers
 * endpoint and the discovery cron — that's an internal concern, not
 * something resource servers query directly.
 */
export function buildSupportedResponse(
  registry: ProviderRegistry,
): FacilitatorSupportedResponse {
  const registeredEnabledIds = new Set(
    registry.enabled().map((p) => p.id),
  );
  const kinds: FacilitatorSupportedKind[] = [];
  for (const key of Object.keys(ROUTING_CONFIG)) {
    const priority = ROUTING_CONFIG[key]!;
    // Advertise the route if ANY of its priority adapters is enabled.
    const hasLiveAdapter = priority.some((id) => registeredEnabledIds.has(id));
    if (!hasLiveAdapter) continue;
    // key is `${network}:${scheme}` — but network identifiers
    // themselves contain ':' (CAIP-2: "eip155:8453"). Split from the
    // RIGHT to recover scheme correctly.
    const lastColon = key.lastIndexOf(":");
    const network = key.slice(0, lastColon);
    const scheme = key.slice(lastColon + 1);
    kinds.push({ x402Version: PROTOCOL_VERSION, scheme, network });
  }
  return {
    kinds,
    extensions: [],
    signers: {},
  };
}

/**
 * True when the given `(network, scheme)` is supported by at least
 * one currently-enabled adapter. Used by /facilitator/verify and
 * /facilitator/settle to early-reject unsupported routes before
 * doing more work.
 */
export function isRouteSupported(
  registry: ProviderRegistry,
  network: string,
  scheme: string,
): boolean {
  const priority = getRoutingPriority(network, scheme);
  if (priority === undefined) return false;
  const ids = new Set(registry.enabled().map((p) => p.id));
  return priority.some((id) => ids.has(id));
}
