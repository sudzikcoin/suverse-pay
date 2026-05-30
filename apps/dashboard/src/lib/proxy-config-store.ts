/**
 * CRUD + validation for self-serve proxy configs. Mirrors the
 * patterns in seller-config.ts:
 *   - Zod schema + cross-field validateProxyConfig()
 *   - dbQuery-backed reads/writes
 *   - Per-namespace payTo enforcement (only required when the
 *     corresponding network family is selected)
 *   - Cross-tenant ownership: every mutating action joins through
 *     dashboard_user_resource_keys so a session can only edit its
 *     own configs
 *
 * Forward-header encryption uses AES-256-GCM keyed by
 * PROXY_HEADER_KEY (same env var the apps/proxy service reads).
 * The dashboard encrypts on PUT and never decrypts on read — only
 * the proxy service decrypts at fetch time. The dashboard never
 * surfaces the plaintext back to the UI after the seller submits
 * the form (same pattern as resource API keys).
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { z } from "zod";
import { dbQuery } from "./db";
import {
  SUPPORTED_CAIP2_IDS,
  selectionNamespaces,
  type NamespaceFamily,
} from "./networks-catalog";
import {
  payToLabel,
  validatePayToFor,
} from "./seller-config";

// ---------------------------------------------------------------
// Encryption (AES-256-GCM, base64( iv[12] || tag[16] || ct ))
// Mirrors apps/proxy/src/crypto.ts exactly.
// ---------------------------------------------------------------

const AES_ALGO = "aes-256-gcm";
const AES_IV_LEN = 12;
const AES_TAG_LEN = 16;

function loadMasterKey(): Buffer {
  const raw = process.env["PROXY_HEADER_KEY"];
  if (!raw) {
    throw new Error(
      "PROXY_HEADER_KEY env var is required to encrypt proxy forward headers",
    );
  }
  const buf = Buffer.from(raw.trim(), "base64");
  if (buf.length !== 32) {
    throw new Error(
      `PROXY_HEADER_KEY must decode to exactly 32 bytes (got ${buf.length})`,
    );
  }
  return buf;
}

function encryptHeaders(headers: Record<string, string>): string {
  const key = loadMasterKey();
  const iv = randomBytes(AES_IV_LEN);
  const cipher = createCipheriv(AES_ALGO, key, iv);
  const ct = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(headers), "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

/** Returns the count of headers (so the UI can show "3 headers set"). */
export function countHeaders(blob: string | null): number {
  if (!blob) return 0;
  try {
    const key = loadMasterKey();
    const buf = Buffer.from(blob, "base64");
    if (buf.length < AES_IV_LEN + AES_TAG_LEN + 1) return 0;
    const iv = buf.subarray(0, AES_IV_LEN);
    const tag = buf.subarray(AES_IV_LEN, AES_IV_LEN + AES_TAG_LEN);
    const ct = buf.subarray(AES_IV_LEN + AES_TAG_LEN);
    const decipher = createDecipheriv(AES_ALGO, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
    const obj = JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
    return Object.keys(obj).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------
// Validation
// ---------------------------------------------------------------

const SlugSchema = z
  .string()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, {
    message:
      "slug must be lowercase letters / digits / hyphens, 2-60 chars (cannot start or end with hyphen)",
  });

const HttpsUrlSchema = z
  .string()
  .url()
  .refine(
    (u) => u.startsWith("https://"),
    "only https:// upstream URLs are accepted",
  );

const PriceAtomicSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/, "price must be a positive integer (atomic units)")
  .refine((s) => {
    try {
      const n = BigInt(s);
      return n >= 1000n && n <= 10_000_000n;
    } catch {
      return false;
    }
  }, "price must be between 1000 and 10000000 atomic units");

/**
 * Headers as a map: name → value. Names trimmed lower-case. Values
 * trimmed. Cap to 16 keys + reject overly long values so a runaway
 * paste doesn't bloat the encrypted blob.
 */
const ForwardHeadersSchema = z
  .record(z.string(), z.string().max(4096))
  .superRefine((obj, ctx) => {
    const keys = Object.keys(obj);
    if (keys.length > 16) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "at most 16 forwarded headers",
      });
    }
    for (const name of keys) {
      if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `invalid header name "${name}" (RFC 7230 token chars only)`,
        });
      }
    }
  })
  .optional();

export const ProxyConfigInputSchema = z.object({
  endpointSlug: SlugSchema,
  originalUrl: HttpsUrlSchema,
  originalMethod: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
  displayName: z.string().min(1).max(120).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  priceAtomic: PriceAtomicSchema,
  acceptedNetworks: z
    .array(z.string())
    .max(30)
    .refine(
      (arr) => arr.every((c) => SUPPORTED_CAIP2_IDS.has(c)),
      "unknown network id",
    ),
  payToEvm: z.string().nullable().optional(),
  payToSolana: z.string().nullable().optional(),
  payToCosmos: z.string().nullable().optional(),
  payToTron: z.string().nullable().optional(),
  forwardHeaders: ForwardHeadersSchema,
  isActive: z.boolean().default(true),
});

export type ProxyConfigInput = z.infer<typeof ProxyConfigInputSchema>;

export function validateProxyConfig(
  input: ProxyConfigInput,
): Array<{ field: string; message: string }> {
  const errors: Array<{ field: string; message: string }> = [];
  const families = selectionNamespaces(input.acceptedNetworks);
  if (input.acceptedNetworks.length === 0) {
    errors.push({
      field: "acceptedNetworks",
      message: "pick at least one network",
    });
  }
  const requireAddr = (
    family: NamespaceFamily,
    fieldName: string,
    value: string | null | undefined,
  ): void => {
    if (!families.has(family)) return;
    if (!value || value.trim() === "") {
      errors.push({
        field: fieldName,
        message: `${payToLabel(family)} address required when a ${family} network is selected`,
      });
      return;
    }
    const reason = validatePayToFor(family, value.trim());
    if (reason !== null) errors.push({ field: fieldName, message: reason });
  };
  requireAddr("evm", "payToEvm", input.payToEvm);
  requireAddr("solana", "payToSolana", input.payToSolana);
  requireAddr("cosmos", "payToCosmos", input.payToCosmos);
  requireAddr("tron", "payToTron", input.payToTron);
  return errors;
}

// ---------------------------------------------------------------
// DB layer
// ---------------------------------------------------------------

export interface ProxyConfigRow {
  id: string;
  resourceKeyId: string;
  endpointSlug: string;
  originalUrl: string;
  originalMethod: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  displayName: string | null;
  description: string | null;
  priceAtomic: string;
  acceptedNetworks: string[];
  payToEvm: string | null;
  payToSolana: string | null;
  payToCosmos: string | null;
  payToTron: string | null;
  forwardHeaderCount: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const SELECT_COLUMNS = `
  id, resource_key_id, endpoint_slug, original_url, original_method,
  display_name, description, price_atomic::text AS price_atomic,
  accepted_networks, pay_to_evm, pay_to_solana, pay_to_cosmos, pay_to_tron,
  forward_headers_encrypted, is_active,
  created_at::text AS created_at, updated_at::text AS updated_at
`;

interface DbRow {
  id: string;
  resource_key_id: string;
  endpoint_slug: string;
  original_url: string;
  original_method: ProxyConfigRow["originalMethod"];
  display_name: string | null;
  description: string | null;
  price_atomic: string;
  accepted_networks: string[];
  pay_to_evm: string | null;
  pay_to_solana: string | null;
  pay_to_cosmos: string | null;
  pay_to_tron: string | null;
  forward_headers_encrypted: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function rowTo(row: DbRow): ProxyConfigRow {
  return {
    id: row.id,
    resourceKeyId: row.resource_key_id,
    endpointSlug: row.endpoint_slug,
    originalUrl: row.original_url,
    originalMethod: row.original_method,
    displayName: row.display_name,
    description: row.description,
    priceAtomic: row.price_atomic,
    acceptedNetworks: row.accepted_networks,
    payToEvm: row.pay_to_evm,
    payToSolana: row.pay_to_solana,
    payToCosmos: row.pay_to_cosmos,
    payToTron: row.pay_to_tron,
    forwardHeaderCount: countHeaders(row.forward_headers_encrypted),
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** List every proxy under any of the user's linked resource keys. */
export async function listProxies(userId: string): Promise<ProxyConfigRow[]> {
  const rows = await dbQuery<DbRow>(
    `
    SELECT ${SELECT_COLUMNS}
      FROM seller_proxy_configs c
      JOIN dashboard_user_resource_keys l ON l.resource_key_id = c.resource_key_id
     WHERE l.user_id = $1
     ORDER BY c.created_at DESC
    `,
    [userId],
  );
  return rows.map(rowTo);
}

/** Cross-tenant guard for single-row read. */
export async function getOwnedProxy(args: {
  userId: string;
  proxyId: string;
}): Promise<ProxyConfigRow | null> {
  const rows = await dbQuery<DbRow>(
    `
    SELECT ${SELECT_COLUMNS}
      FROM seller_proxy_configs c
      JOIN dashboard_user_resource_keys l ON l.resource_key_id = c.resource_key_id
     WHERE l.user_id = $1
       AND c.id = $2
     LIMIT 1
    `,
    [args.userId, args.proxyId],
  );
  const row = rows[0];
  return row ? rowTo(row) : null;
}

/**
 * Insert. Caller has already validated the input (validateProxyConfig)
 * and confirmed the resourceKeyId is owned by the calling user
 * (findOwnedResourceKey from seller-config.ts).
 */
export async function createProxy(args: {
  resourceKeyId: string;
  input: ProxyConfigInput;
}): Promise<ProxyConfigRow> {
  const { input } = args;
  const id = randomUUID();
  const encrypted =
    input.forwardHeaders && Object.keys(input.forwardHeaders).length > 0
      ? encryptHeaders(input.forwardHeaders)
      : null;
  await dbQuery(
    `
    INSERT INTO seller_proxy_configs (
      id, resource_key_id, endpoint_slug, original_url, original_method,
      display_name, description, price_atomic, accepted_networks,
      pay_to_evm, pay_to_solana, pay_to_cosmos, pay_to_tron,
      forward_headers_encrypted, is_active
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::text[],
      $10, $11, $12, $13, $14, $15
    )
    `,
    [
      id,
      args.resourceKeyId,
      input.endpointSlug,
      input.originalUrl,
      input.originalMethod,
      input.displayName ?? null,
      input.description ?? null,
      input.priceAtomic,
      input.acceptedNetworks,
      input.payToEvm ?? null,
      input.payToSolana ?? null,
      input.payToCosmos ?? null,
      input.payToTron ?? null,
      encrypted,
      input.isActive,
    ],
  );
  const created = await dbQuery<DbRow>(
    `SELECT ${SELECT_COLUMNS} FROM seller_proxy_configs WHERE id = $1`,
    [id],
  );
  return rowTo(created[0]!);
}

/**
 * Partial update — fields left undefined keep their current value.
 * forwardHeaders semantics:
 *   - undefined  → keep existing encrypted blob
 *   - null       → clear (set forward_headers_encrypted = NULL)
 *   - {}         → clear (same — empty map means "no headers")
 *   - { ... }    → re-encrypt the new map
 */
export interface UpdateProxyArgs {
  proxyId: string;
  userId: string;
  patch: Partial<Omit<ProxyConfigInput, "endpointSlug">> & {
    forwardHeaders?: Record<string, string> | null;
  };
}

export async function updateProxy(
  args: UpdateProxyArgs,
): Promise<ProxyConfigRow | null> {
  const current = await getOwnedProxy({
    userId: args.userId,
    proxyId: args.proxyId,
  });
  if (!current) return null;

  const p = args.patch;
  const encryptedNext =
    p.forwardHeaders === undefined
      ? undefined
      : p.forwardHeaders === null ||
          Object.keys(p.forwardHeaders).length === 0
        ? null
        : encryptHeaders(p.forwardHeaders);

  await dbQuery(
    `
    UPDATE seller_proxy_configs
       SET original_url      = COALESCE($2, original_url),
           original_method   = COALESCE($3, original_method),
           display_name      = COALESCE($4, display_name),
           description       = COALESCE($5, description),
           price_atomic      = COALESCE($6::numeric, price_atomic),
           accepted_networks = COALESCE($7::text[], accepted_networks),
           pay_to_evm        = COALESCE($8,  pay_to_evm),
           pay_to_solana     = COALESCE($9,  pay_to_solana),
           pay_to_cosmos     = COALESCE($10, pay_to_cosmos),
           pay_to_tron       = COALESCE($11, pay_to_tron),
           forward_headers_encrypted =
             CASE WHEN $13::boolean THEN $12 ELSE forward_headers_encrypted END,
           is_active         = COALESCE($14, is_active),
           updated_at        = NOW()
     WHERE id = $1
    `,
    [
      args.proxyId,
      p.originalUrl ?? null,
      p.originalMethod ?? null,
      p.displayName ?? null,
      p.description ?? null,
      p.priceAtomic ?? null,
      p.acceptedNetworks ?? null,
      p.payToEvm ?? null,
      p.payToSolana ?? null,
      p.payToCosmos ?? null,
      p.payToTron ?? null,
      encryptedNext ?? null,
      encryptedNext !== undefined, // touch flag — when true, COALESCE the explicit value (even NULL)
      p.isActive ?? null,
    ],
  );
  return getOwnedProxy({ userId: args.userId, proxyId: args.proxyId });
}

/** Hard delete. Audit trail (proxy_request_logs) cascades by FK. */
export async function deleteProxy(args: {
  userId: string;
  proxyId: string;
}): Promise<boolean> {
  const rows = await dbQuery<{ id: string }>(
    `
    DELETE FROM seller_proxy_configs c
     USING dashboard_user_resource_keys l
     WHERE l.user_id = $1
       AND l.resource_key_id = c.resource_key_id
       AND c.id = $2
    RETURNING c.id
    `,
    [args.userId, args.proxyId],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------
// Stats + logs
// ---------------------------------------------------------------

export interface ProxyStats {
  totalRequests: number;
  settledCount: number;
  challengeCount: number;
  errorCount: number;
  /** Sum(amount_atomic) for outcome='settled' rows. */
  totalVolumeAtomic: string;
  /** p50 / p95 upstream latency over the last 1000 settled calls. */
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
}

export async function getProxyStats(args: {
  userId: string;
  proxyId: string;
  sinceHours: number;
}): Promise<ProxyStats> {
  const ok = await getOwnedProxy({
    userId: args.userId,
    proxyId: args.proxyId,
  });
  if (!ok) {
    return {
      totalRequests: 0,
      settledCount: 0,
      challengeCount: 0,
      errorCount: 0,
      totalVolumeAtomic: "0",
      p50LatencyMs: null,
      p95LatencyMs: null,
    };
  }
  const sinceMs = args.sinceHours * 60 * 60 * 1000;
  const since = new Date(Date.now() - sinceMs);
  const rows = await dbQuery<{
    total: string;
    settled: string;
    challenge: string;
    err: string;
    volume: string;
    p50: number | null;
    p95: number | null;
  }>(
    `
    SELECT
      COUNT(*)::text                                          AS total,
      COUNT(*) FILTER (WHERE outcome = 'settled')::text       AS settled,
      COUNT(*) FILTER (WHERE outcome = 'challenge')::text     AS challenge,
      COUNT(*) FILTER (WHERE outcome IN
                        ('settle_failed','upstream_error',
                         'rate_limited','invalid_config'))::text AS err,
      COALESCE(SUM(amount_atomic) FILTER (WHERE outcome='settled'),0)::text AS volume,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY upstream_latency_ms)
         FILTER (WHERE outcome='settled' AND upstream_latency_ms IS NOT NULL) AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY upstream_latency_ms)
         FILTER (WHERE outcome='settled' AND upstream_latency_ms IS NOT NULL) AS p95
    FROM proxy_request_logs
    WHERE proxy_config_id = $1
      AND created_at >= $2
    `,
    [args.proxyId, since],
  );
  const r = rows[0]!;
  return {
    totalRequests: Number(r.total),
    settledCount: Number(r.settled),
    challengeCount: Number(r.challenge),
    errorCount: Number(r.err),
    totalVolumeAtomic: r.volume,
    p50LatencyMs: r.p50 === null ? null : Math.round(Number(r.p50)),
    p95LatencyMs: r.p95 === null ? null : Math.round(Number(r.p95)),
  };
}

export interface ProxyLogRow {
  id: string;
  createdAt: string;
  outcome: string;
  network: string | null;
  amountAtomic: string | null;
  txHash: string | null;
  upstreamStatus: number | null;
  upstreamLatencyMs: number | null;
  errorCode: string | null;
}

export async function listProxyLogs(args: {
  userId: string;
  proxyId: string;
  limit: number;
}): Promise<ProxyLogRow[]> {
  const ok = await getOwnedProxy({
    userId: args.userId,
    proxyId: args.proxyId,
  });
  if (!ok) return [];
  const rows = await dbQuery<{
    id: string;
    created_at: string;
    outcome: string;
    network: string | null;
    amount_atomic: string | null;
    tx_hash: string | null;
    upstream_status: number | null;
    upstream_latency_ms: number | null;
    error_code: string | null;
  }>(
    `
    SELECT id, created_at::text AS created_at, outcome, network,
           amount_atomic::text AS amount_atomic, tx_hash,
           upstream_status, upstream_latency_ms, error_code
      FROM proxy_request_logs
     WHERE proxy_config_id = $1
     ORDER BY created_at DESC
     LIMIT $2
    `,
    [args.proxyId, args.limit],
  );
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    outcome: r.outcome,
    network: r.network,
    amountAtomic: r.amount_atomic,
    txHash: r.tx_hash,
    upstreamStatus: r.upstream_status,
    upstreamLatencyMs: r.upstream_latency_ms,
    errorCode: r.error_code,
  }));
}
