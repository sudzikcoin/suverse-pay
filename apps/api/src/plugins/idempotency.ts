import { GatewayError } from "@suverse-pay/core-types";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Surfaces the `Idempotency-Key` header into `request.idempotencyKey`
 * after light validation. Only `/settle` actually requires it — the
 * route handler asserts presence; this plugin just normalizes
 * extraction.
 */
declare module "fastify" {
  interface FastifyRequest {
    idempotencyKey?: string;
  }
}

const HEADER = "idempotency-key";
const MAX_LEN = 255;

export function registerIdempotency(app: FastifyInstance): void {
  app.addHook("onRequest", async (req: FastifyRequest) => {
    const raw = req.headers[HEADER];
    if (raw === undefined) return;
    const value = Array.isArray(raw) ? raw[0]! : raw;
    if (value.length === 0) return;
    if (value.length > MAX_LEN) {
      throw new GatewayError(
        "invalid_request",
        400,
        `Idempotency-Key exceeds ${MAX_LEN} characters`,
      );
    }
    req.idempotencyKey = value;
  });
}
