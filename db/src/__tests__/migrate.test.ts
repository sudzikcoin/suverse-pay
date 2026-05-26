import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "..", "migrations");
const SCHEMA_FILE = join(HERE, "..", "..", "schema.sql");

function newPgMem() {
  const db = newDb({ noAstCoverageCheck: true });
  const { Pool } = db.adapters.createPg();
  // pg-mem's Pool is loosely typed; treat it like our ClientBase contract.
  return new Pool() as unknown as {
    query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
    end: () => Promise<void>;
  };
}

describe("runMigrations", () => {
  let pool: ReturnType<typeof newPgMem> | null = null;

  beforeEach(() => {
    pool = newPgMem();
  });
  afterEach(async () => {
    await pool?.end();
    pool = null;
  });

  it("applies every .sql file in db/migrations on first run", async () => {
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(files.length).toBeGreaterThanOrEqual(1);

    const applied = await runMigrations({
      client: pool! as never,
      log: () => {},
    });
    expect(applied.map((a) => a.name)).toEqual(files);

    const tracked = await pool!.query(
      `SELECT name FROM schema_migrations ORDER BY name ASC`,
    );
    expect((tracked.rows as Array<{ name: string }>).map((r) => r.name)).toEqual(
      files,
    );
  });

  it("creates the canonical table set after applying migrations", async () => {
    await runMigrations({ client: pool! as never, log: () => {} });

    const expectedTables = [
      "api_keys",
      "merchant_policies",
      "providers",
      "provider_capabilities",
      "provider_health_checks",
      "payments",
      "payment_attempts",
      "routing_decisions",
      "schema_migrations",
    ];

    for (const t of expectedTables) {
      const { rows } = await pool!.query(
        `SELECT table_name FROM information_schema.tables WHERE table_name = $1`,
        [t],
      );
      expect(rows.length, `table ${t} should exist`).toBeGreaterThan(0);
    }
  });

  it("is idempotent — applying twice is a no-op the second time", async () => {
    const first = await runMigrations({
      client: pool! as never,
      log: () => {},
    });
    expect(first.length).toBeGreaterThan(0);

    const second = await runMigrations({
      client: pool! as never,
      log: () => {},
    });
    expect(second).toEqual([]);

    // schema_migrations row count must equal the file count, no
    // duplicates.
    const tracked = await pool!.query(
      `SELECT COUNT(*)::int AS c FROM schema_migrations`,
    );
    expect((tracked.rows[0] as { c: number }).c).toBe(first.length);
  });

  it("rolls back a failing migration in its own transaction", async () => {
    // Write a known-bad migration into a temp dir and point the runner
    // at it.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "suverse-pay-migrate-"));
    await writeFile(
      join(dir, "001_broken.sql"),
      "CREATE TABLE will_exist (id INT); SELECT not_a_real_function();",
    );

    await expect(
      runMigrations({ client: pool! as never, migrationsDir: dir, log: () => {} }),
    ).rejects.toThrow(/001_broken\.sql failed/);

    // KNOWN pg-mem GOTCHA: pg-mem does not roll back DDL (CREATE TABLE)
    // inside a transaction, even though real Postgres does. So we can't
    // assert that `will_exist` is gone here — that check is deferred to
    // the real-Postgres integration run (Step 10). What we CAN assert
    // on pg-mem is the data-level guarantee: the schema_migrations
    // bookkeeping row for the failed migration must not be present,
    // which is the actual correctness property the runner depends on.
    const tracked = await pool!.query(
      `SELECT COUNT(*)::int AS c FROM schema_migrations`,
    );
    expect((tracked.rows[0] as { c: number }).c).toBe(0);
  });
});

describe("schema.sql snapshot", () => {
  it("contains every CREATE TABLE statement that appears in the migrations", async () => {
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const migrationSql = (
      await Promise.all(files.map((f) => readFile(join(MIGRATIONS_DIR, f), "utf8")))
    ).join("\n");

    const tableMatches = Array.from(
      migrationSql.matchAll(/CREATE TABLE\s+IF NOT EXISTS\s+(\w+)/gi),
    ).map((m) => m[1]!);

    expect(tableMatches.length).toBeGreaterThan(0);

    const snapshot = await readFile(SCHEMA_FILE, "utf8");
    for (const t of tableMatches) {
      expect(
        snapshot,
        `schema.sql is out of date — missing CREATE TABLE ${t} (regenerate with \`cat db/migrations/*.sql > db/schema.sql\`)`,
      ).toMatch(new RegExp(`CREATE TABLE\\s+IF NOT EXISTS\\s+${t}\\b`, "i"));
    }
  });
});
