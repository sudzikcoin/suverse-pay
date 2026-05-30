import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { dbQuery, getPool } from "./db";
import { normaliseRegions } from "./regions-catalog";
import type { CatalogListing } from "./catalog-search";

/**
 * Persistence layer for the public discovery catalog.
 *
 * Two collaborators:
 *   * /api/catalog route handlers (this module's primary client)
 *   * unit tests in __tests__/catalog-store.test.ts (drive against
 *     a pg-mem pool — see pgMemPool() helper below)
 *
 * All UUIDs are generated app-side via Node crypto so the same
 * code paths run on pg-mem (which lacks gen_random_uuid) and real
 * Postgres without a branching insert path.
 */

/* ────────────────────────────────────────────────────────────────
   Validation
   ──────────────────────────────────────────────────────────────── */

/**
 * Shared input schema for both authenticated submissions and the
 * anonymous public-submit endpoint. The latter wraps this with an
 * additional `email` field. Fields are intentionally permissive:
 * region/network validation lives in normaliseRegions and the
 * network-catalog whitelist.
 */
export const CreateListingSchema = z.object({
  title: z.string().min(3, "title must be ≥3 chars").max(200),
  description: z.string().max(2000).optional(),
  endpointUrl: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), "endpoint must be https://"),
  category: z.string().max(80).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  priceAtomicMin: z.string().regex(/^[0-9]+$/).optional(),
  priceAtomicMax: z.string().regex(/^[0-9]+$/).optional(),
  priceUnit: z.string().max(40).optional(),
  networks: z.array(z.string().max(80)).min(1, "at least one network"),
  regions: z.array(z.string().max(8)).optional(),
  regionRestrictions: z.array(z.string().max(8)).optional(),
  facilitatorUrl: z.string().url().optional(),
  logoUrl: z.string().url().optional(),
  homepageUrl: z.string().url().optional(),
  documentationUrl: z.string().url().optional(),
  /**
   * Optional. If present AND the authenticated user owns the
   * resource_api_key it points at, the listing becomes verified
   * + auto-approved on insert.
   */
  linkResourceKey: z.string().optional(),
});

export type CreateListingInput = z.infer<typeof CreateListingSchema>;

/* ────────────────────────────────────────────────────────────────
   Mappers
   ──────────────────────────────────────────────────────────────── */

interface ListingRow {
  id: string;
  title: string;
  description: string | null;
  endpoint_url: string;
  category: string | null;
  tags: string[] | null;
  price_atomic_min: string | null;
  price_atomic_max: string | null;
  price_unit: string;
  networks: string[] | null;
  regions: string[] | null;
  region_restrictions: string[] | null;
  is_verified: boolean;
  resource_key_id: string | null;
  facilitator_url: string | null;
  submitted_by_user_id: string | null;
  submitted_email: string | null;
  status: "pending" | "approved" | "rejected" | "suspended";
  rejection_reason: string | null;
  logo_url: string | null;
  homepage_url: string | null;
  documentation_url: string | null;
  view_count: number | string;
  click_count: number | string;
  created_at: Date | string;
  published_at: Date | string | null;
}

function toApi(row: ListingRow): CatalogListing {
  // pg-mem returns numeric counts as strings; real pg returns
  // numbers. Coerce both into number for the public-facing shape.
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    endpointUrl: row.endpoint_url,
    category: row.category,
    tags: row.tags ?? [],
    priceAtomicMin: row.price_atomic_min,
    priceAtomicMax: row.price_atomic_max,
    priceUnit: row.price_unit,
    networks: row.networks ?? [],
    regions: row.regions ?? [],
    regionRestrictions: row.region_restrictions ?? [],
    isVerified: row.is_verified,
    resourceKeyId: row.resource_key_id,
    facilitatorUrl: row.facilitator_url,
    status: row.status,
    rejectionReason: row.rejection_reason,
    logoUrl: row.logo_url,
    homepageUrl: row.homepage_url,
    documentationUrl: row.documentation_url,
    viewCount: Number(row.view_count) || 0,
    clickCount: Number(row.click_count) || 0,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    publishedAt:
      row.published_at === null
        ? null
        : row.published_at instanceof Date
        ? row.published_at.toISOString()
        : String(row.published_at),
  };
}

const LISTING_COLUMNS = `
  id, title, description, endpoint_url, category, tags,
  price_atomic_min, price_atomic_max, price_unit,
  networks, regions, region_restrictions,
  is_verified, resource_key_id, facilitator_url,
  submitted_by_user_id, submitted_email,
  status, rejection_reason,
  logo_url, homepage_url, documentation_url,
  view_count, click_count,
  created_at, published_at
`;

/* ────────────────────────────────────────────────────────────────
   Reads
   ──────────────────────────────────────────────────────────────── */

/**
 * Fetch every approved listing. The catalog is small enough for
 * v1 that filtering + sorting in-process (see catalog-search.ts) is
 * fine; once we cross a few thousand approved listings we'll push
 * the predicates into SQL via the GIN indexes on regions/networks.
 */
export async function listApprovedListings(): Promise<CatalogListing[]> {
  const rows = await dbQuery<ListingRow>(
    `SELECT ${LISTING_COLUMNS}
     FROM catalog_listings
     WHERE status = 'approved'
     ORDER BY is_verified DESC, view_count DESC, created_at DESC`,
  );
  return rows.map(toApi);
}

export async function getListing(id: string): Promise<CatalogListing | null> {
  const rows = await dbQuery<ListingRow>(
    `SELECT ${LISTING_COLUMNS}
     FROM catalog_listings WHERE id = $1`,
    [id],
  );
  return rows.length === 0 ? null : toApi(rows[0]!);
}

export async function listUserListings(
  userId: string,
): Promise<CatalogListing[]> {
  const rows = await dbQuery<ListingRow>(
    `SELECT ${LISTING_COLUMNS}
     FROM catalog_listings
     WHERE submitted_by_user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map(toApi);
}

/**
 * Check whether the authenticated user actually owns the
 * resource_api_keys row they want to link this listing to. Used to
 * decide whether a submission is auto-verified.
 */
export async function userOwnsResourceKey(args: {
  userId: string;
  resourceKeyId: string;
}): Promise<boolean> {
  const rows = await dbQuery<{ exists: boolean }>(
    `SELECT TRUE AS exists
     FROM dashboard_user_resource_keys
     WHERE user_id = $1 AND resource_key_id = $2
     LIMIT 1`,
    [args.userId, args.resourceKeyId],
  );
  return rows.length > 0;
}

/* ────────────────────────────────────────────────────────────────
   Writes
   ──────────────────────────────────────────────────────────────── */

export interface InsertListingArgs {
  input: CreateListingInput;
  /** Internal dashboard_users.id. NULL for anonymous public-submit. */
  submittedByUserId: string | null;
  /** Required for anonymous; ignored for authenticated. */
  submittedEmail: string | null;
  submissionIp: string | null;
  /**
   * Caller's decision on the verified/approval tier. Pre-computed
   * (not derived here) so the route handler can read it in its
   * own response without a second DB round-trip.
   */
  isVerified: boolean;
  status: "pending" | "approved";
}

export async function insertListing(
  args: InsertListingArgs,
): Promise<CatalogListing> {
  const id = randomUUID();
  const regions = normaliseRegions(args.input.regions ?? ["global"]);
  const restrictions = args.input.regionRestrictions
    ? normaliseRegions(args.input.regionRestrictions).filter(
        (r) => r !== "global",
      )
    : [];
  const tags = args.input.tags ?? [];
  const publishedAt = args.status === "approved" ? new Date() : null;

  const rows = await dbQuery<ListingRow>(
    `INSERT INTO catalog_listings (
       id, title, description, endpoint_url, category, tags,
       price_atomic_min, price_atomic_max, price_unit,
       networks, regions, region_restrictions,
       is_verified, resource_key_id, facilitator_url,
       submitted_by_user_id, submitted_email, submission_ip,
       status, published_at, view_count, click_count, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9,
       $10, $11, $12,
       $13, $14, $15,
       $16, $17, $18,
       $19, $20, 0, 0, NOW(), NOW()
     )
     RETURNING ${LISTING_COLUMNS}`,
    [
      id,
      args.input.title,
      args.input.description ?? null,
      args.input.endpointUrl,
      args.input.category ?? null,
      tags,
      args.input.priceAtomicMin ?? null,
      args.input.priceAtomicMax ?? null,
      args.input.priceUnit ?? "per-call",
      args.input.networks,
      regions,
      restrictions,
      args.isVerified,
      args.isVerified ? args.input.linkResourceKey ?? null : null,
      args.input.facilitatorUrl ?? null,
      args.submittedByUserId,
      args.submittedEmail,
      args.submissionIp,
      args.status,
      publishedAt,
    ],
  );
  return toApi(rows[0]!);
}

export interface UpdateListingArgs {
  id: string;
  /** UID of the user attempting the update. */
  userId: string;
  patch: Partial<CreateListingInput>;
}

/**
 * Update a listing. Cross-tenant guard: the WHERE clause requires
 * submitted_by_user_id = userId, so a request to edit someone
 * else's listing touches zero rows and we return null (the route
 * handler maps that to 404 — identical to "not found").
 *
 * "Significant" changes (endpoint URL, networks, facilitator URL)
 * flip the row back to status='pending' so admins re-review. Cosmetic
 * fields (title, description, tags, logo, regions) leave status alone.
 */
export async function updateListing(
  args: UpdateListingArgs,
): Promise<CatalogListing | null> {
  const existing = await dbQuery<ListingRow>(
    `SELECT ${LISTING_COLUMNS} FROM catalog_listings
     WHERE id = $1 AND submitted_by_user_id = $2`,
    [args.id, args.userId],
  );
  if (existing.length === 0) return null;
  const cur = existing[0]!;

  const significant =
    (args.patch.endpointUrl !== undefined
      && args.patch.endpointUrl !== cur.endpoint_url)
    || (args.patch.networks !== undefined
      && JSON.stringify([...args.patch.networks].sort())
         !== JSON.stringify([...(cur.networks ?? [])].sort()))
    || (args.patch.facilitatorUrl !== undefined
      && args.patch.facilitatorUrl !== cur.facilitator_url);

  const nextStatus = significant ? "pending" : cur.status;
  const nextPublishedAt = significant ? null : cur.published_at;

  // Hand-stitch the SET clause. Using a CASE-per-field SQL approach
  // would explode in complexity for what's a fixed-field edit form.
  const updated = await dbQuery<ListingRow>(
    `UPDATE catalog_listings SET
       title              = COALESCE($1, title),
       description        = COALESCE($2, description),
       endpoint_url       = COALESCE($3, endpoint_url),
       category           = COALESCE($4, category),
       tags               = COALESCE($5, tags),
       price_atomic_min   = COALESCE($6, price_atomic_min),
       price_atomic_max   = COALESCE($7, price_atomic_max),
       price_unit         = COALESCE($8, price_unit),
       networks           = COALESCE($9, networks),
       regions            = COALESCE($10, regions),
       region_restrictions= COALESCE($11, region_restrictions),
       facilitator_url    = COALESCE($12, facilitator_url),
       logo_url           = COALESCE($13, logo_url),
       homepage_url       = COALESCE($14, homepage_url),
       documentation_url  = COALESCE($15, documentation_url),
       status             = $16,
       published_at       = $17,
       updated_at         = NOW()
     WHERE id = $18 AND submitted_by_user_id = $19
     RETURNING ${LISTING_COLUMNS}`,
    [
      args.patch.title ?? null,
      args.patch.description ?? null,
      args.patch.endpointUrl ?? null,
      args.patch.category ?? null,
      args.patch.tags ?? null,
      args.patch.priceAtomicMin ?? null,
      args.patch.priceAtomicMax ?? null,
      args.patch.priceUnit ?? null,
      args.patch.networks ?? null,
      args.patch.regions ? normaliseRegions(args.patch.regions) : null,
      args.patch.regionRestrictions
        ? normaliseRegions(args.patch.regionRestrictions).filter(
            (r) => r !== "global",
          )
        : null,
      args.patch.facilitatorUrl ?? null,
      args.patch.logoUrl ?? null,
      args.patch.homepageUrl ?? null,
      args.patch.documentationUrl ?? null,
      nextStatus,
      nextPublishedAt,
      args.id,
      args.userId,
    ],
  );
  return updated.length === 0 ? null : toApi(updated[0]!);
}

/**
 * Soft-delete: status='suspended'. We never hard-DELETE the row
 * because catalog_external_submissions FKs against it with CASCADE
 * — that audit trail (who submitted what, when) must survive a
 * delete. Returns true iff a row was affected.
 */
export async function suspendListing(args: {
  id: string;
  userId: string;
}): Promise<boolean> {
  const result = await dbQuery<{ id: string }>(
    `UPDATE catalog_listings
     SET status = 'suspended', updated_at = NOW()
     WHERE id = $1 AND submitted_by_user_id = $2
     RETURNING id`,
    [args.id, args.userId],
  );
  return result.length > 0;
}

/**
 * Increment view_count for the detail page. Uses a single UPDATE
 * rather than SELECT-then-UPDATE so it stays race-safe. Rate
 * limiting per IP is the route handler's job — this is the SQL
 * primitive.
 */
export async function incrementViewCount(id: string): Promise<void> {
  await getPool().query(
    `UPDATE catalog_listings
     SET view_count = view_count + 1
     WHERE id = $1 AND status = 'approved'`,
    [id],
  );
}

export async function incrementClickCount(id: string): Promise<void> {
  await getPool().query(
    `UPDATE catalog_listings
     SET click_count = click_count + 1
     WHERE id = $1 AND status = 'approved'`,
    [id],
  );
}

/* ────────────────────────────────────────────────────────────────
   Anonymous submission verification
   ──────────────────────────────────────────────────────────────── */

const TOKEN_EXPIRY_DAYS = 7;

export interface CreateExternalSubmissionArgs {
  listingId: string;
  email: string;
}

export interface ExternalSubmissionRow {
  id: string;
  listingId: string;
  email: string;
  verificationToken: string;
  verifiedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export async function createExternalSubmission(
  args: CreateExternalSubmissionArgs,
): Promise<ExternalSubmissionRow> {
  const id = randomUUID();
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(
    Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  );
  const rows = await dbQuery<{
    id: string;
    listing_id: string;
    email: string;
    verification_token: string;
    verified_at: Date | null;
    expires_at: Date | string;
    created_at: Date | string;
  }>(
    `INSERT INTO catalog_external_submissions (
       id, listing_id, email, verification_token, expires_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, NOW())
     RETURNING id, listing_id, email, verification_token,
               verified_at, expires_at, created_at`,
    [id, args.listingId, args.email, token, expiresAt],
  );
  const r = rows[0]!;
  return {
    id: r.id,
    listingId: r.listing_id,
    email: r.email,
    verificationToken: r.verification_token,
    verifiedAt: null,
    expiresAt:
      r.expires_at instanceof Date
        ? r.expires_at.toISOString()
        : String(r.expires_at),
    createdAt:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at),
  };
}

export interface VerifyResult {
  ok: boolean;
  /** Failure reason for the user-facing page. */
  reason?: "not-found" | "expired" | "already-verified";
  listingId?: string;
}

export async function verifyExternalSubmission(
  token: string,
): Promise<VerifyResult> {
  const rows = await dbQuery<{
    id: string;
    listing_id: string;
    verified_at: Date | null;
    expires_at: Date | string;
  }>(
    `SELECT id, listing_id, verified_at, expires_at
     FROM catalog_external_submissions
     WHERE verification_token = $1`,
    [token],
  );
  if (rows.length === 0) return { ok: false, reason: "not-found" };
  const row = rows[0]!;
  if (row.verified_at !== null) {
    return { ok: true, reason: "already-verified", listingId: row.listing_id };
  }
  const expiresAt =
    row.expires_at instanceof Date
      ? row.expires_at
      : new Date(String(row.expires_at));
  if (expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  await getPool().query(
    `UPDATE catalog_external_submissions
     SET verified_at = NOW()
     WHERE id = $1`,
    [row.id],
  );
  return { ok: true, listingId: row.listing_id };
}

/* ────────────────────────────────────────────────────────────────
   Rate limiting (anonymous submissions)
   ──────────────────────────────────────────────────────────────── */

/**
 * Hard cap on anonymous submissions per IP per 24h window. Without
 * a real shared rate-limiter (Redis would be Phase-2), we count
 * recent rows in catalog_listings by submission_ip — good enough to
 * keep a casual abuser out without being a CAPTCHA replacement.
 */
export const ANON_SUBMIT_LIMIT_PER_DAY = 3;

export async function countAnonymousSubmissionsLast24h(
  ip: string,
): Promise<number> {
  const rows = await dbQuery<{ c: number | string }>(
    `SELECT COUNT(*)::int AS c FROM catalog_listings
     WHERE submission_ip = $1
       AND submitted_by_user_id IS NULL
       AND created_at >= $2`,
    [ip, new Date(Date.now() - 24 * 60 * 60 * 1000)],
  );
  return Number(rows[0]?.c ?? 0);
}
