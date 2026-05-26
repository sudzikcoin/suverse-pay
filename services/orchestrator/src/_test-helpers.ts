/**
 * Test-only utilities for spinning up pg-mem + ioredis-mock. Excluded
 * from the tsc build (see tsconfig.json's "exclude").
 *
 * Each call to `createTestStack()` produces a fresh in-memory Postgres
 * instance with the orchestrator schema applied, an in-memory Redis
 * instance, a `pg.Pool` adapter wired to the database, and a seeded
 * api_keys + providers row set so foreign keys are satisfied.
 */
import { newDb } from "pg-mem";
import type { Pool } from "pg";
// @ts-expect-error — ioredis-mock has no published types
import IORedisMock from "ioredis-mock";
import type Redis from "ioredis";
import { TEST_SCHEMA_SQL } from "./test-schema.js";

export interface TestStack {
  pool: Pool;
  redis: Redis;
  /** API key id seeded for tests. */
  apiKeyId: string;
  /** Provider ids seeded for tests. */
  providerIds: string[];
  /** Releases pool connections (does NOT reset state). */
  close(): Promise<void>;
}

export async function createTestStack(opts: {
  apiKeyId?: string;
  providerIds?: string[];
} = {}): Promise<TestStack> {
  const apiKeyId = opts.apiKeyId ?? "apikey_test";
  const providerIds = opts.providerIds ?? ["cosmos-pay", "coinbase-cdp"];

  const db = newDb({ autoCreateForeignKeyIndices: true });
  // NOW() / CURRENT_TIMESTAMP are supported out of the box, but
  // BIGSERIAL needs a small registration of the pg_get_serial_sequence
  // helper that pg-mem doesn't ship; relax with .none()-style ignore.
  // (No-op in practice: BIGSERIAL works directly in pg-mem v3.)
  db.public.none(TEST_SCHEMA_SQL);

  // Seed referenced rows.
  db.public.none(
    `INSERT INTO api_keys (id, key_hash) VALUES ('${apiKeyId}', 'hash')`,
  );
  for (const pid of providerIds) {
    db.public.none(
      `INSERT INTO providers (id, display_name, config, enabled)
       VALUES ('${pid}', '${pid}', '{}'::jsonb, TRUE)`,
    );
  }

  const adapters = db.adapters.createPg();
  const pool: Pool = new adapters.Pool();
  const redis: Redis = new IORedisMock();
  // ioredis-mock shares state across instances by default; explicitly
  // reset so concurrent test files don't poison each other.
  await redis.flushall();

  return {
    pool,
    redis,
    apiKeyId,
    providerIds,
    async close() {
      await pool.end();
      await redis.quit();
    },
  };
}
