import { GatewayError } from "@suverse-pay/core-types";
import {
  findResourceKey,
  touchResourceKey,
  type ResourceKeyRow,
} from "@suverse-pay/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by `requireResourceKey` after auth succeeds. */
    resourceKey?: ResourceKeyRow;
  }
}

const BEARER_PREFIX = "Bearer ";

/**
 * Fastify preHandler that authenticates a /facilitator/settle request
 * via `Authorization: Bearer <resource-api-key>`. On success, attaches
 * the resolved `resource_api_keys` row to `request.resourceKey`.
 *
 * This is INTENTIONALLY a route-level preHandler (not a server-wide
 * `onRequest` hook) — the admin-key auth from
 * `plugins/auth.ts` still owns the v0.1 routes (/verify, /settle,
 * /providers, /quote, etc), and the two auth tiers must not collide.
 */
export function requireResourceKey(pool: Pool) {
  return async (req: FastifyRequest): Promise<void> => {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith(BEARER_PREFIX)) {
      throw new GatewayError(
        "unauthorized",
        401,
        "missing or malformed Authorization header (expected 'Bearer <resource-api-key>')",
      );
    }
    const supplied = header.slice(BEARER_PREFIX.length).trim();
    if (supplied.length === 0) {
      throw new GatewayError("unauthorized", 401, "empty bearer token");
    }
    const row = await findResourceKey({ client: pool, plaintext: supplied });
    if (row === null) {
      throw new GatewayError("unauthorized", 401, "invalid resource api key");
    }
    req.resourceKey = row;
    // Best-effort last-used update — don't block on it. Errors are
    // ignored because a transient Postgres write failure shouldn't
    // fail an otherwise-valid request.
    touchResourceKey({ client: pool, id: row.id }).catch(() => {});
  };
}

/**
 * Register `request.resourceKey = undefined` decoration so Fastify
 * doesn't reject the type even when the route doesn't run
 * requireResourceKey. Call once at server boot.
 */
export function registerResourceKeyAuth(app: FastifyInstance): void {
  app.decorateRequest("resourceKey");
}
