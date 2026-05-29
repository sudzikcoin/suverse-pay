import { randomUUID } from "node:crypto";
import type { ClientBase, Pool, PoolClient } from "pg";
import { generateSecretPlaintext } from "./signer.js";

export type WebhookEventType = "settle.succeeded" | "settle.failed";

export const KNOWN_EVENT_TYPES: ReadonlyArray<WebhookEventType> = [
  "settle.succeeded",
  "settle.failed",
] as const;

export interface WebhookEndpointRow {
  id: string;
  dashboardUserId: string;
  url: string;
  /**
   * PLAINTEXT HMAC signing secret. Stored as text because the
   * delivery worker needs the actual bytes to sign each payload.
   * Treat as sensitive — never log, never expose outside the
   * authenticated owner's dashboard.
   */
  secret: string;
  description: string;
  events: ReadonlyArray<WebhookEventType>;
  isActive: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface CreateEndpointOptions {
  client: ClientBase | PoolClient | Pool;
  dashboardUserId: string;
  url: string;
  description?: string;
  events?: ReadonlyArray<WebhookEventType>;
}

export interface CreatedWebhookEndpoint {
  row: WebhookEndpointRow;
  /**
   * Plaintext signing secret. Equal to `row.secret` in the current
   * design (we store plaintext at rest for HMAC signing), but kept
   * as a distinct return field so the call site clearly marks the
   * "show this to the customer EXACTLY ONCE" moment — if we ever
   * encrypt-at-rest, the two values diverge and the API contract
   * still makes sense.
   */
  secretPlaintext: string;
}

export async function createWebhookEndpoint(
  opts: CreateEndpointOptions,
): Promise<CreatedWebhookEndpoint> {
  if (opts.url.length === 0) throw new Error("url is required");
  if (!opts.url.startsWith("http://") && !opts.url.startsWith("https://")) {
    throw new Error("url must start with http:// or https://");
  }
  const events = opts.events ?? KNOWN_EVENT_TYPES;
  if (events.length === 0) {
    throw new Error("at least one event must be subscribed");
  }
  for (const e of events) {
    if (!KNOWN_EVENT_TYPES.includes(e)) {
      throw new Error(`unknown event type: ${e}`);
    }
  }
  const id = randomUUID();
  const secretPlaintext = generateSecretPlaintext();
  const description = opts.description ?? "";
  const { rows } = await opts.client.query(
    `INSERT INTO webhook_endpoints
       (id, dashboard_user_id, url, secret, description, events)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, dashboard_user_id, url, secret, description,
               events, is_active, created_at, last_used_at`,
    [id, opts.dashboardUserId, opts.url, secretPlaintext, description, events],
  );
  return { row: rowToEndpoint(rows[0]), secretPlaintext };
}

export interface ListEndpointsOptions {
  client: ClientBase | PoolClient | Pool;
  dashboardUserId: string;
}

export async function listEndpointsForUser(
  opts: ListEndpointsOptions,
): Promise<WebhookEndpointRow[]> {
  const { rows } = await opts.client.query(
    `SELECT id, dashboard_user_id, url, secret, description,
            events, is_active, created_at, last_used_at
       FROM webhook_endpoints
      WHERE dashboard_user_id = $1
      ORDER BY created_at DESC`,
    [opts.dashboardUserId],
  );
  return rows.map(rowToEndpoint);
}

export interface GetEndpointOptions {
  client: ClientBase | PoolClient | Pool;
  id: string;
  /** When set, scope the query — caller-side multi-tenant safety. */
  dashboardUserId?: string;
}

export async function getEndpointById(
  opts: GetEndpointOptions,
): Promise<WebhookEndpointRow | null> {
  const params: unknown[] = [opts.id];
  let scope = "";
  if (opts.dashboardUserId !== undefined) {
    params.push(opts.dashboardUserId);
    scope = "AND dashboard_user_id = $2";
  }
  const { rows } = await opts.client.query(
    `SELECT id, dashboard_user_id, url, secret, description,
            events, is_active, created_at, last_used_at
       FROM webhook_endpoints
      WHERE id = $1 ${scope}
      LIMIT 1`,
    params,
  );
  if (rows.length === 0) return null;
  return rowToEndpoint(rows[0]);
}

export interface FindMatchingEndpointsOptions {
  client: ClientBase | PoolClient | Pool;
  resourceKeyId: string;
  eventType: WebhookEventType;
}

/**
 * Resolve fan-out: given the resource key that produced a settle,
 * find every active webhook endpoint that should receive the event.
 *
 * Trace: facilitator_payments.resource_key_id
 *   → dashboard_user_resource_keys → dashboard_users
 *   → webhook_endpoints (where event_type ∈ events AND is_active)
 *
 * Note: a resource key may be linked to multiple dashboard users
 * (e.g. an account that was claimed by both members of a team).
 * Each gets their own copy of the event — webhook_deliveries is
 * keyed by endpoint so the rows are naturally distinct.
 */
export async function findMatchingEndpoints(
  opts: FindMatchingEndpointsOptions,
): Promise<WebhookEndpointRow[]> {
  const { rows } = await opts.client.query(
    `SELECT we.id, we.dashboard_user_id, we.url, we.secret, we.description,
            we.events, we.is_active, we.created_at, we.last_used_at
       FROM webhook_endpoints we
       JOIN dashboard_user_resource_keys l ON l.user_id = we.dashboard_user_id
      WHERE l.resource_key_id = $1
        AND we.is_active = TRUE
        AND $2 = ANY(we.events)`,
    [opts.resourceKeyId, opts.eventType],
  );
  return rows.map(rowToEndpoint);
}

export interface DeleteEndpointOptions {
  client: ClientBase | PoolClient | Pool;
  id: string;
  dashboardUserId: string;
}

/**
 * Hard delete — `webhook_deliveries` cascade away too. Customers
 * who want history without delivery can flip is_active instead;
 * the dashboard UI exposes both flows.
 */
export async function deleteEndpoint(
  opts: DeleteEndpointOptions,
): Promise<boolean> {
  const { rowCount } = await opts.client.query(
    `DELETE FROM webhook_endpoints
      WHERE id = $1 AND dashboard_user_id = $2`,
    [opts.id, opts.dashboardUserId],
  );
  return (rowCount ?? 0) > 0;
}

export async function touchEndpointLastUsed(
  client: ClientBase | PoolClient | Pool,
  endpointId: string,
): Promise<void> {
  await client.query(
    `UPDATE webhook_endpoints SET last_used_at = NOW() WHERE id = $1`,
    [endpointId],
  );
}

function rowToEndpoint(r: {
  id: string;
  dashboard_user_id: string;
  url: string;
  secret: string;
  description: string;
  events: string[];
  is_active: boolean;
  created_at: Date;
  last_used_at: Date | null;
}): WebhookEndpointRow {
  return {
    id: r.id,
    dashboardUserId: r.dashboard_user_id,
    url: r.url,
    secret: r.secret,
    description: r.description,
    events: r.events as WebhookEventType[],
    isActive: r.is_active,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}
