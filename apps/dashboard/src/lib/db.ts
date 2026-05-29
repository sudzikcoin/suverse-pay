import { Pool } from "pg";

/**
 * Shared Postgres pool for dashboard route handlers. Connects to the
 * same database apps/api uses (the dashboard reads
 * facilitator_payments + resource_api_keys and writes its own
 * dashboard_users / dashboard_user_resource_keys tables).
 *
 * Single global pool per Node process — Next.js may instantiate
 * route handler modules multiple times during dev, so we hang the
 * pool off `globalThis` to avoid creating one per HMR cycle.
 */
const globalForPool = globalThis as unknown as { __pgPool?: Pool };

export function getPool(): Pool {
  if (!globalForPool.__pgPool) {
    const url = process.env.DATABASE_URL;
    if (!url || url.length === 0) {
      throw new Error(
        "DATABASE_URL not set — see apps/dashboard/.env.example",
      );
    }
    globalForPool.__pgPool = new Pool({
      connectionString: url,
      // The dashboard's queries are light (aggregations on indexed
      // columns + small selects); 4 connections is enough for v1.
      // Raise in production once we see real load.
      max: 4,
      idleTimeoutMillis: 30_000,
    });
  }
  return globalForPool.__pgPool;
}

/**
 * Convenience for one-shot queries. The `T` type parameter is the
 * row shape callers expect; we cast `pg`'s `QueryResultRow` at the
 * boundary so callers can use regular `interface` declarations
 * without needing the `[key: string]: unknown` index signature
 * `pg.query<R extends QueryResultRow>` would otherwise demand.
 */
export async function dbQuery<T>(
  text: string,
  params?: ReadonlyArray<unknown>,
): Promise<T[]> {
  const res = await getPool().query(text, params ? [...params] : undefined);
  return res.rows as T[];
}
