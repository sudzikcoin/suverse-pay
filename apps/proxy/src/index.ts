/**
 * Boot entrypoint for the proxy service. Reads config from env,
 * opens a Postgres pool, builds the Fastify app, listens.
 *
 * Required env:
 *   - DATABASE_URL          postgres connection string
 *   - PROXY_HEADER_KEY      base64-encoded 32-byte AES master key
 *   - FACILITATOR_URL       e.g. https://facilitator.suverse.io
 *   - PROXY_RESOURCE_API_KEY  sup_live_... key the proxy uses to
 *                             talk to the facilitator (this is the
 *                             "system" key for the proxy's own
 *                             /facilitator/settle calls — same shape
 *                             as any seller's key, just owned by the
 *                             proxy operator)
 * Optional env:
 *   - PORT                       default 3003
 *   - HOST                       default 0.0.0.0
 *   - REDIS_URL                  enables shared rate-limit state
 *   - RATE_LIMIT_PER_MIN         default 120
 *   - LOG_LEVEL                  default info
 *   - HEALTH_CHECK_TIMEOUT_MS    pre-charge upstream probe budget,
 *                                default 3000
 */

import pg from "pg";
import { loadMasterKey } from "./crypto.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const databaseUrl = required("DATABASE_URL");
  const facilitatorUrl = required("FACILITATOR_URL");
  const facilitatorApiKey = required("PROXY_RESOURCE_API_KEY");
  const masterKey = loadMasterKey();

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 16,
    idleTimeoutMillis: 30_000,
  });

  const healthCheckTimeoutMs = parsePositiveInt(
    process.env["HEALTH_CHECK_TIMEOUT_MS"],
  );

  const app = await buildServer({
    pool,
    masterKey,
    facilitatorUrl,
    facilitatorApiKey,
    ...(process.env["REDIS_URL"]
      ? { redisUrl: process.env["REDIS_URL"] }
      : {}),
    rateLimitPerMin: Number(process.env["RATE_LIMIT_PER_MIN"] ?? 120),
    ...(healthCheckTimeoutMs !== undefined ? { healthCheckTimeoutMs } : {}),
  });

  const port = Number(process.env["PORT"] ?? 3003);
  const host = process.env["HOST"] ?? "0.0.0.0";

  await app.listen({ port, host });
  app.log.info(`proxy listening on ${host}:${port}`);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal} — shutting down`);
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

function required(name: string): string {
  const v = process.env[name];
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

/** Parse an optional positive integer env var; return undefined on absence or junk. */
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("proxy: fatal boot error", err);
  process.exit(1);
});
