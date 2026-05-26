import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_API_KEY_ID,
  AdminKeyRotationRequiredError,
  bootstrapAdminApiKey,
  sha256ApiKeyHash,
} from "../index.js";
import { runMigrations } from "../migrate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "..", "migrations");

function newPgMem() {
  const db = newDb({ noAstCoverageCheck: true });
  const { Pool } = db.adapters.createPg();
  return new Pool() as unknown as {
    query: <T = unknown>(
      text: string,
      values?: unknown[],
    ) => Promise<{ rows: T[] }>;
    end: () => Promise<void>;
  };
}

async function freshDb() {
  const pool = newPgMem();
  await runMigrations({
    client: pool as never,
    migrationsDir: MIGRATIONS_DIR,
    log: () => {},
  });
  return pool;
}

describe("bootstrapAdminApiKey", () => {
  let pool: Awaited<ReturnType<typeof freshDb>> | null = null;

  beforeEach(async () => {
    pool = await freshDb();
  });
  afterEach(async () => {
    await pool?.end();
    pool = null;
  });

  it("inserts a fresh admin row when the table is empty", async () => {
    const r = await bootstrapAdminApiKey({
      client: pool! as never,
      adminApiKey: "secret-1",
    });
    expect(r.action).toBe("created");
    expect(r.keyId).toBe(ADMIN_API_KEY_ID);

    const rows = (
      await pool!.query<{ id: string; key_hash: string; label: string }>(
        `SELECT id, key_hash, label FROM api_keys WHERE id = $1`,
        [ADMIN_API_KEY_ID],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key_hash).toBe(sha256ApiKeyHash("secret-1"));
    expect(rows[0]!.label).toBe("default-admin");
  });

  it("is idempotent: a second call with the same key returns skipped", async () => {
    await bootstrapAdminApiKey({
      client: pool! as never,
      adminApiKey: "secret-1",
    });
    const second = await bootstrapAdminApiKey({
      client: pool! as never,
      adminApiKey: "secret-1",
    });
    expect(second.action).toBe("skipped");

    const count = (
      await pool!.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM api_keys`,
      )
    ).rows[0]!.c;
    expect(count).toBe(1);
  });

  it("refuses to silently overwrite a row with a different hash (no --force)", async () => {
    await bootstrapAdminApiKey({
      client: pool! as never,
      adminApiKey: "old-key",
    });
    await expect(
      bootstrapAdminApiKey({
        client: pool! as never,
        adminApiKey: "new-key",
      }),
    ).rejects.toBeInstanceOf(AdminKeyRotationRequiredError);

    // Hash on disk is still the old one.
    const row = (
      await pool!.query<{ key_hash: string }>(
        `SELECT key_hash FROM api_keys WHERE id = $1`,
        [ADMIN_API_KEY_ID],
      )
    ).rows[0]!;
    expect(row.key_hash).toBe(sha256ApiKeyHash("old-key"));
  });

  it("rotates the hash when force=true", async () => {
    await bootstrapAdminApiKey({
      client: pool! as never,
      adminApiKey: "old-key",
    });
    const rotated = await bootstrapAdminApiKey({
      client: pool! as never,
      adminApiKey: "new-key",
      force: true,
    });
    expect(rotated.action).toBe("rotated");

    const row = (
      await pool!.query<{ key_hash: string }>(
        `SELECT key_hash FROM api_keys WHERE id = $1`,
        [ADMIN_API_KEY_ID],
      )
    ).rows[0]!;
    expect(row.key_hash).toBe(sha256ApiKeyHash("new-key"));
  });

  it("rejects an empty plaintext key", async () => {
    await expect(
      bootstrapAdminApiKey({ client: pool! as never, adminApiKey: "" }),
    ).rejects.toThrow(/empty/);

    const count = (
      await pool!.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM api_keys`,
      )
    ).rows[0]!.c;
    expect(count).toBe(0);
  });
});

describe("sha256ApiKeyHash", () => {
  it("is deterministic", () => {
    expect(sha256ApiKeyHash("hello")).toBe(sha256ApiKeyHash("hello"));
  });

  it("produces a 64-char lowercase hex string", () => {
    const h = sha256ApiKeyHash("anything");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the canonical sha256 hex of 'hello' (cross-check vs. openssl)", () => {
    // echo -n hello | openssl dgst -sha256
    expect(sha256ApiKeyHash("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
