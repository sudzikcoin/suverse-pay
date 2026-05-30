import type { ProviderRegistry } from "@suverse-pay/orchestrator";
import type { Pool } from "pg";
import { getRoutingPriority, ROUTING_CONFIG } from "./routing-config.js";

export interface FacilitatorSupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  /**
   * Per-kind extras the *primary* enabled adapter (per ROUTING_CONFIG
   * priority) wants surfaced to sellers/buyers. Examples:
   *   Solana: `{ feePayer: <base58 pubkey> }`
   *   Cosmos: `{ facilitator, chainId, decimals, symbol }`
   *   EVM:    `{ name, version }` (EIP-712 USDC domain)
   * Absent when no enabled adapter has recorded extras for this kind.
   */
  extra?: Record<string, unknown>;
}

export interface FacilitatorSupportedResponse {
  /** x402 v2 facilitator spec: `kinds` array. */
  kinds: FacilitatorSupportedKind[];
  /** Extensions slot per spec — empty for v0.3.0. */
  extensions: string[];
  /**
   * Map of CAIP-2 patterns → public signer addresses. Populated from
   * per-kind extras so buyers can defend against facilitator
   * impersonation: every `solana:*` payment routed through this
   * facilitator should land in the wallet listed here; ditto cosmos.
   * EVM adapters don't publish a single signer pubkey today, so
   * `eip155:*` is normally absent.
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
 * When `pool` is supplied, also joins `provider_capabilities` to
 * carry the primary-adapter's per-kind `extras_json` into the
 * response and aggregates a `signers` map by CAIP-2 namespace prefix.
 * Without a pool (test/dev setups) the response is just kinds — same
 * shape as before PR-A, no extras, empty signers map. Tests that
 * don't construct a pool keep working.
 *
 * The aggregated set is per-(scheme, network); `asset` is NOT in the
 * spec's /supported response shape (x402 v2 §7.3). Capability
 * discovery for assets happens via the adapter-level /providers
 * endpoint and the discovery cron — that's an internal concern, not
 * something resource servers query directly.
 */
export async function buildSupportedResponse(
  registry: ProviderRegistry,
  pool?: Pool,
): Promise<FacilitatorSupportedResponse> {
  const registeredEnabledIds = new Set(
    registry.enabled().map((p) => p.id),
  );

  // Map `${network}:${scheme}` → extras_json of the PRIMARY enabled
  // adapter for that kind (per ROUTING_CONFIG order). Empty when no
  // pool or when no row exists yet.
  const extrasByKind = pool !== undefined
    ? await loadPrimaryExtras(pool, registeredEnabledIds)
    : new Map<string, Record<string, unknown>>();

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
    const extra = extrasByKind.get(key);
    kinds.push({
      x402Version: PROTOCOL_VERSION,
      scheme,
      network,
      ...(extra !== undefined ? { extra } : {}),
    });
  }

  return {
    kinds,
    extensions: [],
    signers: aggregateSigners(kinds),
  };
}

/**
 * For each (network, scheme) in ROUTING_CONFIG, find the first
 * adapter id in the priority list that's enabled and load its
 * `extras_json` row from `provider_capabilities`. Returns a map
 * keyed by `${network}:${scheme}` (the same key shape ROUTING_CONFIG
 * uses).
 *
 * A single SQL round-trip pulls every (provider, network, scheme)
 * row at once; the per-kind lookup happens in JS. With ~57 active
 * rows across 8 adapters this is faster than per-kind queries by
 * an order of magnitude AND simpler than building a JOIN over the
 * static routing config (which lives in TS code, not the DB).
 */
async function loadPrimaryExtras(
  pool: Pool,
  enabledIds: Set<string>,
): Promise<Map<string, Record<string, unknown>>> {
  if (enabledIds.size === 0) return new Map();
  const rows = await pool.query<{
    provider_id: string;
    network: string;
    scheme: string;
    extras_json: Record<string, unknown> | null;
  }>(
    `SELECT provider_id, network, scheme, extras_json
       FROM provider_capabilities
      WHERE provider_id = ANY($1::text[])
        AND superseded_at IS NULL
        AND extras_json IS NOT NULL`,
    [Array.from(enabledIds)],
  );
  // Index rows by (provider_id, network, scheme) for O(1) primary lookup.
  // A given (network, scheme) may have multiple assets (e.g. Solana
  // mainnet has USDC + USDT mints); their extras are typically identical
  // for the same provider+kind, so first row wins per provider+kind.
  const byProviderKind = new Map<string, Record<string, unknown>>();
  for (const row of rows.rows) {
    if (row.extras_json === null) continue;
    const k = `${row.provider_id}|${row.network}|${row.scheme}`;
    if (!byProviderKind.has(k)) byProviderKind.set(k, row.extras_json);
  }

  // Walk ROUTING_CONFIG, pick the first enabled adapter's extras per kind.
  const out = new Map<string, Record<string, unknown>>();
  for (const [routingKey, priority] of Object.entries(ROUTING_CONFIG)) {
    const lastColon = routingKey.lastIndexOf(":");
    const network = routingKey.slice(0, lastColon);
    const scheme = routingKey.slice(lastColon + 1);
    for (const providerId of priority) {
      if (!enabledIds.has(providerId)) continue;
      const extras = byProviderKind.get(`${providerId}|${network}|${scheme}`);
      if (extras !== undefined) {
        out.set(routingKey, extras);
        break;
      }
    }
  }
  return out;
}

/**
 * Aggregate facilitator signer addresses by CAIP-2 namespace.
 *
 * Sources signer addresses from per-kind extras:
 *   Solana → extras.feePayer  → signers["solana:*"]
 *   Cosmos → extras.facilitator → signers["cosmos:*"]
 *
 * Result is a map of namespace pattern → sorted unique addresses.
 * EVM adapters don't publish a single signer pubkey through extras
 * today; the EVM entry stays absent until adapters expose it (Phase
 * follow-up). Empty namespaces are omitted from the response (no
 * `solana:*: []` noise).
 */
function aggregateSigners(
  kinds: ReadonlyArray<FacilitatorSupportedKind>,
): Record<string, string[]> {
  const acc = new Map<string, Set<string>>();
  for (const kind of kinds) {
    const extra = kind.extra;
    if (extra === undefined) continue;
    const namespace = kind.network.split(":")[0];
    if (namespace === undefined || namespace.length === 0) continue;
    const pattern = `${namespace}:*`;
    if (namespace === "solana" && typeof extra["feePayer"] === "string") {
      acc.set(pattern, (acc.get(pattern) ?? new Set()).add(extra["feePayer"]));
    } else if (namespace === "cosmos" && typeof extra["facilitator"] === "string") {
      acc.set(pattern, (acc.get(pattern) ?? new Set()).add(extra["facilitator"]));
    }
    // EVM and TRON: no signer-address surface in PR-A. Add cases here
    // when the relevant adapters start emitting one.
  }
  const out: Record<string, string[]> = {};
  for (const [pattern, set] of acc) {
    out[pattern] = Array.from(set).sort();
  }
  return out;
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
