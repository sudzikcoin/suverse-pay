/**
 * Buyer-side data access helpers. Keep query SQL here so route
 * handlers + server components stay focused on auth + rendering.
 *
 * All queries are scoped to a user via their registered buyer_wallets.
 * Returning an empty result when no wallets are registered is the
 * correct behaviour — the UI surfaces an "add a wallet" empty state.
 */

import { createHash, randomBytes } from "node:crypto";
import { dbQuery } from "./db";

export type Mode = "seller" | "buyer";

export interface BuyerWallet {
  id: string;
  networkFamily: "evm" | "solana" | "cosmos" | "tron";
  address: string;
  label: string | null;
  linkedAt: string;
}

export async function getUserMode(userId: string): Promise<Mode> {
  const rows = await dbQuery<{ preferred_mode: Mode }>(
    `SELECT preferred_mode FROM dashboard_users WHERE id = $1`,
    [userId],
  );
  return rows[0]?.preferred_mode ?? "seller";
}

export async function setUserMode(userId: string, mode: Mode): Promise<void> {
  await dbQuery(
    `UPDATE dashboard_users SET preferred_mode = $2 WHERE id = $1`,
    [userId, mode],
  );
}

/**
 * Per-chain address format check. Pragmatic regex — catches the
 * obvious typos (wrong chain prefix, wrong length, base58-invalid
 * chars). NOT a cryptographic proof of ownership; v1 trusts the
 * claim and surfaces public on-chain facts only.
 */
export function validateAddress(
  family: BuyerWallet["networkFamily"],
  address: string,
): { ok: true } | { ok: false; reason: string } {
  const a = address.trim();
  switch (family) {
    case "evm":
      if (!/^0x[0-9a-fA-F]{40}$/.test(a)) {
        return { ok: false, reason: "EVM addresses are 0x + 40 hex chars" };
      }
      return { ok: true };
    case "solana":
      // Base58 (no 0, O, I, l), 32-44 chars covers all real pubkeys.
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) {
        return {
          ok: false,
          reason: "Solana addresses are 32–44 base58 chars (no 0/O/I/l)",
        };
      }
      return { ok: true };
    case "cosmos":
      // Noble bech32: human-readable part "noble", then "1", then 38+ chars.
      if (!/^noble1[023456789ac-hj-np-z]{38,}$/.test(a)) {
        return {
          ok: false,
          reason: "Cosmos Noble addresses start with 'noble1' (bech32)",
        };
      }
      return { ok: true };
    case "tron":
      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) {
        return {
          ok: false,
          reason: "TRON addresses start with 'T' (34 chars total, base58)",
        };
      }
      return { ok: true };
  }
}

export async function addWallet(
  userId: string,
  args: { networkFamily: BuyerWallet["networkFamily"]; address: string; label?: string },
): Promise<{ id: string } | null> {
  const check = validateAddress(args.networkFamily, args.address);
  if (!check.ok) {
    throw new Error(`invalid_address:${check.reason}`);
  }
  // Canonical storage rules: EVM lower-cased (mixed-case checksum is
  // just visual aid); Cosmos bech32 is always lowercase; TRON +
  // Solana are case-sensitive base58 and stored as-pasted.
  const trimmed = args.address.trim();
  const address =
    args.networkFamily === "evm" || args.networkFamily === "cosmos"
      ? trimmed.toLowerCase()
      : trimmed;
  const id = crypto.randomUUID();
  const rows = await dbQuery<{ id: string }>(
    `INSERT INTO buyer_wallets (id, user_id, network_family, address, label)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, network_family, address) DO NOTHING
     RETURNING id`,
    [id, userId, args.networkFamily, address, args.label ?? null],
  );
  return rows.length === 0 ? null : { id: rows[0]!.id };
}

export async function deleteWallet(userId: string, walletId: string): Promise<boolean> {
  const rows = await dbQuery<{ id: string }>(
    `DELETE FROM buyer_wallets WHERE id = $1 AND user_id = $2 RETURNING id`,
    [walletId, userId],
  );
  return rows.length > 0;
}

export async function listWallets(userId: string): Promise<BuyerWallet[]> {
  const rows = await dbQuery<{
    id: string;
    network_family: BuyerWallet["networkFamily"];
    address: string;
    label: string | null;
    linked_at: Date;
  }>(
    `SELECT id, network_family, address, label, linked_at
       FROM buyer_wallets
       WHERE user_id = $1
       ORDER BY linked_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    networkFamily: r.network_family,
    address: r.address,
    label: r.label,
    linkedAt:
      r.linked_at instanceof Date
        ? r.linked_at.toISOString()
        : String(r.linked_at),
  }));
}

/**
 * Returns lowercased addresses (so the EVM/TRON-mixed-case case
 * pastes resolve to the same payer entries on lookup). Solana +
 * Cosmos addresses keep their original case but are also compared
 * case-insensitively at the query layer for convenience.
 */
async function listWalletAddressesLower(userId: string): Promise<string[]> {
  const rows = await dbQuery<{ address: string }>(
    `SELECT lower(address) AS address
       FROM buyer_wallets
       WHERE user_id = $1`,
    [userId],
  );
  return rows.map((r) => r.address);
}

export interface BuyerSummary {
  totalAtomic: string;
  txCount: number;
  settledCount: number;
  failedCount: number;
  topEndpoints: Array<{
    recipient: string;
    txCount: number;
    totalAtomic: string;
  }>;
  byNetwork: Array<{ network: string; txCount: number; totalAtomic: string }>;
}

export type SummaryPeriod = "24h" | "7d" | "30d";

const PERIOD_INTERVAL: Record<SummaryPeriod, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

/**
 * Aggregate buyer spend over the period. NUMERIC sums come back as
 * strings (preserve BigInt precision; client formats via atomicToUsd).
 */
export async function getBuyerSummary(
  userId: string,
  period: SummaryPeriod,
): Promise<BuyerSummary> {
  const addrs = await listWalletAddressesLower(userId);
  if (addrs.length === 0) {
    return {
      totalAtomic: "0",
      txCount: 0,
      settledCount: 0,
      failedCount: 0,
      topEndpoints: [],
      byNetwork: [],
    };
  }
  const interval = PERIOD_INTERVAL[period];
  const since = new Date(Date.now() - intervalToMs(period));

  const summaryRows = await dbQuery<{
    total_atomic: string | null;
    tx_count: string;
    settled_count: string;
    failed_count: string;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'settled' THEN amount::numeric ELSE 0 END), 0)::text AS total_atomic,
       COUNT(*)::text AS tx_count,
       COUNT(*) FILTER (WHERE status = 'settled')::text AS settled_count,
       COUNT(*) FILTER (WHERE status = 'failed')::text   AS failed_count
     FROM facilitator_payments
     WHERE lower(payer) = ANY($1::text[])
       AND created_at >= $2`,
    [addrs, since],
  );

  const topRows = await dbQuery<{
    recipient: string;
    tx_count: string;
    total_atomic: string;
  }>(
    `SELECT
       recipient,
       COUNT(*)::text AS tx_count,
       SUM(amount::numeric)::text AS total_atomic
     FROM facilitator_payments
     WHERE lower(payer) = ANY($1::text[])
       AND status = 'settled'
       AND created_at >= $2
     GROUP BY recipient
     ORDER BY SUM(amount::numeric) DESC
     LIMIT 5`,
    [addrs, since],
  );

  const networkRows = await dbQuery<{
    network: string;
    tx_count: string;
    total_atomic: string;
  }>(
    `SELECT
       network,
       COUNT(*)::text AS tx_count,
       SUM(amount::numeric)::text AS total_atomic
     FROM facilitator_payments
     WHERE lower(payer) = ANY($1::text[])
       AND status = 'settled'
       AND created_at >= $2
     GROUP BY network
     ORDER BY SUM(amount::numeric) DESC`,
    [addrs, since],
  );

  const head = summaryRows[0]!;
  // `interval` is captured in PERIOD_INTERVAL but not actually used
  // in the SQL — we compute the `since` cutoff in JS for
  // portability. Kept here for documentation; intentionally
  // referenced to silence the unused-var lint.
  void interval;
  return {
    totalAtomic: head.total_atomic ?? "0",
    txCount: Number(head.tx_count),
    settledCount: Number(head.settled_count),
    failedCount: Number(head.failed_count),
    topEndpoints: topRows.map((r) => ({
      recipient: r.recipient,
      txCount: Number(r.tx_count),
      totalAtomic: r.total_atomic,
    })),
    byNetwork: networkRows.map((r) => ({
      network: r.network,
      txCount: Number(r.tx_count),
      totalAtomic: r.total_atomic,
    })),
  };
}

function intervalToMs(p: SummaryPeriod): number {
  switch (p) {
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return 30 * 24 * 60 * 60 * 1000;
  }
}

export interface BuyerPayment {
  id: string;
  createdAt: string;
  network: string;
  amount: string;
  asset: string;
  payer: string | null;
  recipient: string;
  txHash: string | null;
  status: string;
  errorCode: string | null;
}

export interface ListPaymentsOptions {
  /** ISO date string lower bound (inclusive). */
  since?: string;
  /** ISO date string upper bound (exclusive). */
  until?: string;
  /** CAIP-2 network filter. */
  network?: string;
  /** Substring filter on recipient address. */
  recipient?: string;
  /** 1-based page (default 1). */
  page?: number;
  /** Page size (default 50, max 500). */
  pageSize?: number;
}

export interface ListPaymentsResult {
  payments: BuyerPayment[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Paginated payment list for the buyer dashboard. Same wallet
 * scoping as the summary; supports network/date/recipient filters.
 * Returns total count alongside the page so the UI can show
 * "Showing 1-50 of 312" without a second query.
 */
/* ────────────────────────────────────────────────────────────────
   Agent API keys
   ──────────────────────────────────────────────────────────────── */

export interface AgentKey {
  id: string;
  label: string;
  isActive: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface CreatedAgentKey extends AgentKey {
  /** Plaintext — shown ONCE. */
  plaintext: string;
}

const AGENT_KEY_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function generateAgentKeyPlaintext(): string {
  const buf = randomBytes(32);
  let out = "sup_agent_";
  for (let i = 0; i < 32; i++) {
    out += AGENT_KEY_ALPHABET[buf[i]! % AGENT_KEY_ALPHABET.length];
  }
  return out;
}

function generateAgentKeyId(): string {
  return `agtkey_${randomBytes(4).toString("hex")}`;
}

export async function listAgentKeys(userId: string): Promise<AgentKey[]> {
  const rows = await dbQuery<{
    id: string;
    label: string;
    is_active: boolean;
    created_at: Date;
    last_used_at: Date | null;
  }>(
    `SELECT id, label, is_active, created_at, last_used_at
       FROM agent_keys
       WHERE user_id = $1
       ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    isActive: r.is_active,
    createdAt: r.created_at.toISOString(),
    lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
  }));
}

export async function createAgentKey(args: {
  userId: string;
  label: string;
}): Promise<CreatedAgentKey> {
  if (args.label.length === 0 || args.label.length > 80) {
    throw new Error("label must be 1-80 characters");
  }
  const plaintext = generateAgentKeyPlaintext();
  const hash = createHash("sha256").update(plaintext, "utf8").digest("hex");
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = generateAgentKeyId();
    try {
      const rows = await dbQuery<{ created_at: Date }>(
        `INSERT INTO agent_keys (id, user_id, label, key_hash)
           VALUES ($1, $2, $3, $4)
         RETURNING created_at`,
        [id, args.userId, args.label, hash],
      );
      const created = rows[0]!;
      return {
        id,
        label: args.label,
        isActive: true,
        createdAt: created.created_at.toISOString(),
        lastUsedAt: null,
        plaintext,
      };
    } catch (e) {
      if (attempt === 4) throw e;
      // Collision (UNIQUE on key_hash or PK) — try again.
    }
  }
  throw new Error("agent key generation collided 5 times");
}

export async function revokeAgentKey(
  userId: string,
  id: string,
): Promise<boolean> {
  const rows = await dbQuery<{ id: string }>(
    `UPDATE agent_keys SET is_active = FALSE
       WHERE id = $1 AND user_id = $2 AND is_active = TRUE
     RETURNING id`,
    [id, userId],
  );
  return rows.length > 0;
}

/* ────────────────────────────────────────────────────────────────
   Spending limits — accounting-only in v1
   ──────────────────────────────────────────────────────────────── */

export type LimitScope = "user" | "agent_key" | "endpoint";
export type LimitPeriod = "day" | "week" | "month";

export interface SpendingLimit {
  id: string;
  scope: LimitScope;
  scopeId: string | null;
  period: LimitPeriod;
  maxAtomicUsd: string;
  enabled: boolean;
  notifyEmail: boolean;
  autoPause: boolean;
  createdAt: string;
}

export async function listLimits(userId: string): Promise<SpendingLimit[]> {
  const rows = await dbQuery<{
    id: string;
    scope: LimitScope;
    scope_id: string | null;
    period: LimitPeriod;
    max_atomic_usd: string;
    enabled: boolean;
    notify_email: boolean;
    auto_pause: boolean;
    created_at: Date;
  }>(
    `SELECT id, scope, scope_id, period, max_atomic_usd,
            enabled, notify_email, auto_pause, created_at
       FROM spending_limits
       WHERE user_id = $1
       ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    scopeId: r.scope_id,
    period: r.period,
    maxAtomicUsd: r.max_atomic_usd,
    enabled: r.enabled,
    notifyEmail: r.notify_email,
    autoPause: r.auto_pause,
    createdAt: r.created_at.toISOString(),
  }));
}

export async function createLimit(args: {
  userId: string;
  scope: LimitScope;
  scopeId: string | null;
  period: LimitPeriod;
  maxAtomicUsd: string;
  notifyEmail: boolean;
  autoPause: boolean;
}): Promise<{ id: string } | null> {
  try {
    BigInt(args.maxAtomicUsd);
  } catch {
    throw new Error("max_atomic_usd must be a decimal integer string");
  }
  const id = crypto.randomUUID();
  const rows = await dbQuery<{ id: string }>(
    `INSERT INTO spending_limits
       (id, user_id, scope, scope_id, period, max_atomic_usd, notify_email, auto_pause)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, scope, scope_id, period) DO NOTHING
     RETURNING id`,
    [
      id,
      args.userId,
      args.scope,
      args.scopeId,
      args.period,
      args.maxAtomicUsd,
      args.notifyEmail,
      args.autoPause,
    ],
  );
  return rows.length === 0 ? null : { id: rows[0]!.id };
}

export async function deleteLimit(
  userId: string,
  id: string,
): Promise<boolean> {
  const rows = await dbQuery<{ id: string }>(
    `DELETE FROM spending_limits WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId],
  );
  return rows.length > 0;
}

export async function setLimitEnabled(
  userId: string,
  id: string,
  enabled: boolean,
): Promise<boolean> {
  const rows = await dbQuery<{ id: string }>(
    `UPDATE spending_limits SET enabled = $3
       WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [id, userId, enabled],
  );
  return rows.length > 0;
}

export async function listBuyerPayments(
  userId: string,
  opts: ListPaymentsOptions = {},
): Promise<ListPaymentsResult> {
  const addrs = await listWalletAddressesLower(userId);
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, opts.pageSize ?? 50));
  if (addrs.length === 0) {
    return { payments: [], total: 0, page, pageSize };
  }
  const where: string[] = [`lower(payer) = ANY($1::text[])`];
  const params: unknown[] = [addrs];
  let ix = 2;
  if (opts.since) {
    where.push(`created_at >= $${ix++}`);
    params.push(new Date(opts.since));
  }
  if (opts.until) {
    where.push(`created_at < $${ix++}`);
    params.push(new Date(opts.until));
  }
  if (opts.network) {
    where.push(`network = $${ix++}`);
    params.push(opts.network);
  }
  if (opts.recipient) {
    where.push(`recipient ILIKE $${ix++}`);
    params.push(`%${opts.recipient}%`);
  }
  const whereClause = where.join(" AND ");

  // Aggregate count first — cheap with our partial payer index.
  const countRows = await dbQuery<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM facilitator_payments WHERE ${whereClause}`,
    params,
  );
  const total = Number(countRows[0]?.c ?? "0");

  const offset = (page - 1) * pageSize;
  const rows = await dbQuery<{
    id: string;
    created_at: Date;
    network: string;
    amount: string;
    asset: string;
    payer: string | null;
    recipient: string;
    tx_hash: string | null;
    status: string;
    error_code: string | null;
  }>(
    `SELECT id, created_at, network, amount, asset, payer, recipient,
            tx_hash, status, error_code
       FROM facilitator_payments
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${ix} OFFSET $${ix + 1}`,
    [...params, pageSize, offset],
  );

  return {
    payments: rows.map((r) => ({
      id: r.id,
      createdAt:
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : String(r.created_at),
      network: r.network,
      amount: r.amount,
      asset: r.asset,
      payer: r.payer,
      recipient: r.recipient,
      txHash: r.tx_hash,
      status: r.status,
      errorCode: r.error_code,
    })),
    total,
    page,
    pageSize,
  };
}
