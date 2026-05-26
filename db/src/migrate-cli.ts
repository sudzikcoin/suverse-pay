import pg from "pg";
import { runMigrations } from "./migrate.js";

const { Pool } = pg;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  const pool = new Pool({ connectionString: url });
  try {
    const applied = await runMigrations({ client: pool });
    process.stdout.write(`migrations: ${applied.length} applied\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `migrate failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
