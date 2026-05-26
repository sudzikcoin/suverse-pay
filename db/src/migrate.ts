import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientBase, Pool, PoolClient } from "pg";
import pg from "pg";

const { Pool: PgPool } = pg;

/**
 * Where migrations live relative to the compiled output. The runtime
 * is `dist/migrate.js`; migrations are at the package root in
 * `migrations/`. Source layout is `src/migrate.ts` next to the same
 * `migrations/` directory at the package root, so the relative path
 * from either build target is `../migrations`.
 */
function defaultMigrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
}

export interface RunMigrationsOptions {
  /** Existing pool/client to apply against. Caller owns its lifecycle. */
  client: ClientBase | PoolClient | Pool;
  /** Absolute path to a directory of `*.sql` files. */
  migrationsDir?: string;
  /** Override stdout logging during tests. */
  log?: (msg: string) => void;
}

export interface AppliedMigration {
  name: string;
  appliedAt: Date;
}

/**
 * Applies every `.sql` file in `migrationsDir` (sorted by filename)
 * that has not already been recorded in `schema_migrations`. Each
 * migration runs inside its own transaction — partial application
 * is impossible.
 *
 * Bootstrap: `schema_migrations` itself is created up front, outside
 * any transaction, with `IF NOT EXISTS`, so the runner is safe to
 * call against an empty database or one that has already been
 * partially migrated.
 *
 * Returns the list of migrations that were applied on this run
 * (already-applied migrations are skipped silently).
 */
export async function runMigrations(
  opts: RunMigrationsOptions,
): Promise<AppliedMigration[]> {
  const dir = opts.migrationsDir ?? defaultMigrationsDir();
  const log = opts.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const client = opts.client;

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const files = (await readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    log("no migrations to apply");
    return [];
  }

  const applied: AppliedMigration[] = [];
  for (const file of files) {
    const { rows } = await client.query<{ name: string }>(
      `SELECT name FROM schema_migrations WHERE name = $1`,
      [file],
    );
    if (rows.length > 0) {
      log(`= ${file} (already applied)`);
      continue;
    }

    const sql = await readFile(join(dir, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        `INSERT INTO schema_migrations (name) VALUES ($1)`,
        [file],
      );
      await client.query("COMMIT");
      applied.push({ name: file, appliedAt: new Date() });
      log(`+ ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(
        `migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
  return applied;
}

/**
 * CLI entry point lives in `migrate-cli.ts`. This module exports
 * only the pure runner so callers (tests, the bootstrap script, the
 * api server's own pre-flight check) can drive it against any
 * `ClientBase | Pool`.
 */
export { PgPool };
