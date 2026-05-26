import pg from "pg";
import { bootstrapAdminApiKey } from "./bootstrap.js";

const { Pool } = pg;

const FORCE_FLAGS = new Set(["--force", "-f"]);

async function main(): Promise<void> {
  const force =
    process.argv.slice(2).some((a) => FORCE_FLAGS.has(a)) ||
    process.env.ADMIN_API_KEY_FORCE === "1";

  const url = process.env.DATABASE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  const key = process.env.ADMIN_API_KEY;
  if (key === undefined || key.length === 0) {
    throw new Error("ADMIN_API_KEY is required (refusing to bootstrap)");
  }

  const pool = new Pool({ connectionString: url });
  try {
    const result = await bootstrapAdminApiKey({
      client: pool,
      adminApiKey: key,
      force,
    });
    // Hash itself is non-secret and is helpful for diagnostics. The
    // plaintext key is NEVER logged.
    process.stdout.write(
      `admin api_key '${result.keyId}': ${result.action}\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `bootstrap failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
