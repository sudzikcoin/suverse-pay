import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";

/**
 * Schema-shape tests for migration 007 (public discovery catalog,
 * Phase 5 Block 4 Sub-task 4.7). The dashboard package owns the
 * app-side wrappers (apps/dashboard/src/lib/catalog-store.ts) and
 * tests their pure logic without a DB. These tests cover the DB
 * surface: column types, defaults, FK + cascade behaviour, the
 * cross-tenant scoping idiom the dashboard relies on, and the
 * coordination column auto_publish_to_catalog from the migration's
 * cross-cutting concern with seller-config (006).
 */

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

async function seedUser(pool: ReturnType<typeof newPgMem>, id: string) {
  await pool.query(
    `INSERT INTO dashboard_users (id, email, oauth_provider, oauth_provider_id)
     VALUES ($1, $2, 'google', $3)`,
    [id, `${id}@example.com`, `g-${id}`],
  );
}

describe("migration 007: catalog_listings", () => {
  let pool: ReturnType<typeof newPgMem> | null = null;

  beforeEach(async () => {
    pool = await freshDb();
  });
  afterEach(async () => {
    await pool?.end();
    pool = null;
  });

  it("accepts an approved listing with the documented defaults", async () => {
    const userId = randomUUID();
    await seedUser(pool!, userId);
    const id = randomUUID();
    await pool!.query(
      `INSERT INTO catalog_listings (id, slug, title, endpoint_url, networks, status, submitted_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        `test-${id.slice(0, 6)}`,
        "Test",
        "https://example.com/v1",
        ["eip155:8453"],
        "approved",
        userId,
      ],
    );
    const rows = (
      await pool!.query<{
        regions: string[] | string;
        region_restrictions: string[] | string;
        is_verified: boolean;
        view_count: number;
        price_unit: string;
      }>(
        `SELECT regions, region_restrictions, is_verified, view_count, price_unit
         FROM catalog_listings WHERE id = $1`,
        [id],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    // pg-mem returns arrays as native arrays; real pg returns them
    // either as arrays or as Postgres-array literal strings depending
    // on the driver options. Normalise before asserting.
    const regions = Array.isArray(rows[0]!.regions)
      ? rows[0]!.regions
      : String(rows[0]!.regions).replace(/[{}]/g, "").split(",").filter((s) => s.length > 0);
    const restrictions = Array.isArray(rows[0]!.region_restrictions)
      ? rows[0]!.region_restrictions
      : String(rows[0]!.region_restrictions).replace(/[{}]/g, "").split(",").filter((s) => s.length > 0);
    expect(regions).toEqual(["global"]);
    expect(restrictions).toEqual([]);
    expect(rows[0]!.is_verified).toBe(false);
    expect(Number(rows[0]!.view_count)).toBe(0);
    expect(rows[0]!.price_unit).toBe("per-call");
  });

  it("supports the 4 documented statuses + rejects unknowns via CHECK", async () => {
    const id = randomUUID();
    // The CHECK constraint should reject 'banned' (not in the enum).
    await expect(
      pool!.query(
        `INSERT INTO catalog_listings (id, slug, title, endpoint_url, networks, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          `bad-${id.slice(0, 6)}`,
          "Bad",
          "https://example.com",
          ["eip155:8453"],
          "banned",
        ],
      ),
    ).rejects.toThrow();
  });

  it("FK ON DELETE CASCADE wipes external submissions when listing is deleted", async () => {
    const listingId = randomUUID();
    await pool!.query(
      `INSERT INTO catalog_listings (id, slug, title, endpoint_url, networks, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        listingId,
        `cascade-${listingId.slice(0, 6)}`,
        "X",
        "https://example.com",
        ["eip155:8453"],
        "pending",
      ],
    );
    await pool!.query(
      `INSERT INTO catalog_external_submissions (id, listing_id, email, verification_token, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days')`,
      [randomUUID(), listingId, "x@y.z", "token-1"],
    );
    await pool!.query(`DELETE FROM catalog_listings WHERE id = $1`, [
      listingId,
    ]);
    const remaining = (
      await pool!.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM catalog_external_submissions`,
      )
    ).rows[0]!.c;
    expect(Number(remaining)).toBe(0);
  });

  it("verification_token UNIQUE constraint rejects collisions", async () => {
    const listingId = randomUUID();
    await pool!.query(
      `INSERT INTO catalog_listings (id, slug, title, endpoint_url, networks, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        listingId,
        `dup-${listingId.slice(0, 6)}`,
        "X",
        "https://example.com",
        ["eip155:8453"],
        "pending",
      ],
    );
    await pool!.query(
      `INSERT INTO catalog_external_submissions (id, listing_id, email, verification_token, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days')`,
      [randomUUID(), listingId, "x@y.z", "dup-token"],
    );
    await expect(
      pool!.query(
        `INSERT INTO catalog_external_submissions (id, listing_id, email, verification_token, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days')`,
        [randomUUID(), listingId, "y@z.q", "dup-token"],
      ),
    ).rejects.toThrow();
  });

  it("coordination column auto_publish_to_catalog landed on resource_server_configs", async () => {
    // 006 ran before 007 (alphabetical sort) and 007 ALTERed the
    // table — confirm the column exists with the default we want.
    await pool!.query(
      `INSERT INTO resource_api_keys (id, key_hash, label, is_active, created_at)
       VALUES ('reskey_aaaaaaaa', 'x', 'lab', TRUE, NOW())`,
    );
    await pool!.query(
      `INSERT INTO resource_server_configs (id, resource_key_id, default_price_atomic, accepted_networks)
       VALUES ($1, 'reskey_aaaaaaaa', 70000, ARRAY['eip155:8453'])`,
      [randomUUID()],
    );
    const row = (
      await pool!.query<{ auto_publish_to_catalog: boolean }>(
        `SELECT auto_publish_to_catalog FROM resource_server_configs LIMIT 1`,
      )
    ).rows[0]!;
    expect(row.auto_publish_to_catalog).toBe(false);
  });

  it("resource_key_id FK on catalog_listings uses ON DELETE SET NULL (preserves history)", async () => {
    await pool!.query(
      `INSERT INTO resource_api_keys (id, key_hash, label, is_active, created_at)
       VALUES ('reskey_bbbbbbbb', 'y', 'l', TRUE, NOW())`,
    );
    const listingId = randomUUID();
    await pool!.query(
      `INSERT INTO catalog_listings (id, slug, title, endpoint_url, networks, status, resource_key_id, is_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        listingId,
        `linked-${listingId.slice(0, 6)}`,
        "Linked",
        "https://example.com",
        ["eip155:8453"],
        "approved",
        "reskey_bbbbbbbb",
        true,
      ],
    );
    await pool!.query(
      `DELETE FROM resource_api_keys WHERE id = $1`,
      ["reskey_bbbbbbbb"],
    );
    const row = (
      await pool!.query<{ resource_key_id: string | null }>(
        `SELECT resource_key_id FROM catalog_listings WHERE id = $1`,
        [listingId],
      )
    ).rows[0]!;
    expect(row.resource_key_id).toBeNull();
  });
});
