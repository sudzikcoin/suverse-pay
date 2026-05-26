import type {
  Caip2,
  ProviderAdapter,
} from "@suverse-pay/core-types";
import type { Pool } from "pg";
import type { CapabilityRow, Logger, RegisteredProvider } from "./types.js";
import { NOOP_LOGGER } from "./types.js";

export interface RegisterOptions {
  displayName?: string;
  config?: Record<string, unknown>;
  staticCapabilities: ReadonlyArray<{
    network: Caip2;
    asset: string;
    scheme: string;
  }>;
  enabled?: boolean;
}

/**
 * In-process registry of ProviderAdapter instances plus the canonical
 * `providers` + `provider_capabilities` rows in Postgres.
 *
 * Registration is idempotent: re-registering the same adapter id
 * upserts the providers row and the static capability rows. Discovery
 * updates (Step: CapabilityDiscoveryCron) live in
 * `provider_capabilities` with `is_discovered = TRUE` and are queried
 * separately via `listCapabilities()`.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, RegisteredProvider>();

  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger = NOOP_LOGGER,
  ) {}

  async register(
    adapter: ProviderAdapter,
    opts: RegisterOptions,
  ): Promise<void> {
    const displayName = opts.displayName ?? adapter.displayName;
    const config = opts.config ?? {};
    const enabled = opts.enabled ?? true;

    await this.pool.query(
      `INSERT INTO providers (id, display_name, config, enabled, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         config = EXCLUDED.config,
         enabled = EXCLUDED.enabled`,
      [adapter.id, displayName, JSON.stringify(config), enabled],
    );

    for (const cap of opts.staticCapabilities) {
      await this.pool.query(
        `INSERT INTO provider_capabilities (
           provider_id, network, asset, scheme, is_static, is_discovered
         ) VALUES ($1, $2, $3, $4, TRUE, FALSE)
         ON CONFLICT (provider_id, network, asset, scheme) DO UPDATE SET
           is_static = TRUE,
           superseded_at = NULL`,
        [adapter.id, cap.network, cap.asset, cap.scheme],
      );
    }

    this.providers.set(adapter.id, {
      id: adapter.id,
      displayName,
      adapter,
      config,
      enabled,
    });
    this.logger.info(`registered provider ${adapter.id}`, {
      capabilities: opts.staticCapabilities.length,
    });
  }

  list(): RegisteredProvider[] {
    return Array.from(this.providers.values());
  }

  getById(id: string): RegisteredProvider | undefined {
    return this.providers.get(id);
  }

  enabled(): RegisteredProvider[] {
    return this.list().filter((p) => p.enabled);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const p = this.providers.get(id);
    if (!p) throw new Error(`unknown provider: ${id}`);
    this.providers.set(id, { ...p, enabled });
    await this.pool.query(
      `UPDATE providers SET enabled = $2 WHERE id = $1`,
      [id, enabled],
    );
  }

  /**
   * Returns the union of static + discovered capability rows for a
   * given provider, excluding superseded entries. Powers GET /providers.
   */
  async listCapabilities(providerId: string): Promise<CapabilityRow[]> {
    const result = await this.pool.query<{
      provider_id: string;
      network: string;
      asset: string;
      scheme: string;
      is_static: boolean;
      is_discovered: boolean;
      discovered_at: Date | null;
      superseded_at: Date | null;
    }>(
      `SELECT provider_id, network, asset, scheme,
              is_static, is_discovered, discovered_at, superseded_at
       FROM provider_capabilities
       WHERE provider_id = $1 AND superseded_at IS NULL`,
      [providerId],
    );
    return result.rows.map((row) => ({
      providerId: row.provider_id,
      network: row.network as Caip2,
      asset: row.asset,
      scheme: row.scheme,
      isStatic: row.is_static,
      isDiscovered: row.is_discovered,
      discoveredAt: row.discovered_at,
      supersededAt: row.superseded_at,
    }));
  }
}
