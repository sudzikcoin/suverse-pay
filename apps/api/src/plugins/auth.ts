import { createHash } from "node:crypto";
import { GatewayError } from "@suverse-pay/core-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.js";

/**
 * v0.1 single-key auth.
 *
 * Bootstrap (Step 9) inserts one row in `api_keys` with
 * `id='apikey_admin_default'` and `key_hash = sha256(ADMIN_API_KEY)`.
 * The server holds the same hash in memory and rejects any request
 * whose `Authorization: Bearer <key>` does not hash to the stored
 * value. We do NOT hit the DB on every request — the in-memory hash
 * is the floor; multi-tenant lookup is a Phase 4 concern.
 *
 * Phase 4 will keep the same `request.apiKeyId` shape, just pulled
 * from a DB lookup. Routes touch `request.apiKeyId` only; they never
 * see the raw header.
 */
declare module "fastify" {
  interface FastifyRequest {
    apiKeyId: string;
  }
}

export const ADMIN_API_KEY_ID = "apikey_admin_default";

const BEARER_PREFIX = "Bearer ";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Constant-time string comparison. The pair of inputs is hex so all
 * bytes are length-equal; we still defend against an off-length attacker
 * by short-circuiting on length first (no information leak — length is
 * a known constant 64).
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export interface AuthOptions {
  config: Config;
  /**
   * Endpoints exempt from auth. v0.1: just `/health` for liveness
   * probes (industry convention for k8s-style health checks; the
   * endpoint reveals nothing beyond "process is up").
   */
  exempt?: ReadonlySet<string>;
}

export function registerAuth(app: FastifyInstance, opts: AuthOptions): void {
  const adminHash = sha256Hex(opts.config.adminApiKey);
  const exempt = opts.exempt ?? new Set(["/health"]);

  app.addHook("onRequest", async (req: FastifyRequest) => {
    if (exempt.has(req.routeOptions.url ?? req.url)) return;

    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith(BEARER_PREFIX)) {
      throw new GatewayError(
        "unauthorized",
        401,
        "missing or malformed Authorization header (expected 'Bearer <key>')",
      );
    }
    const supplied = header.slice(BEARER_PREFIX.length).trim();
    if (supplied.length === 0) {
      throw new GatewayError("unauthorized", 401, "empty bearer token");
    }
    const suppliedHash = sha256Hex(supplied);
    if (!safeEqual(suppliedHash, adminHash)) {
      throw new GatewayError("unauthorized", 401, "invalid api key");
    }
    req.apiKeyId = ADMIN_API_KEY_ID;
  });
}
