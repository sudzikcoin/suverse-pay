/**
 * Fastify adapter. Register the returned plugin or attach the
 * pre-handler directly:
 *
 *   import Fastify from "fastify";
 *   import { createFastifyPreHandler } from "@suverselabs/x402-server/fastify";
 *
 *   const app = Fastify();
 *   const x402 = createFastifyPreHandler({
 *     apiKey: process.env.SUVERSE_PAY_API_KEY!,
 *     facilitator: "https://facilitator.suverse.io",
 *     acceptedPayments: [...],
 *   });
 *
 *   app.post("/paid", { preHandler: x402 }, async (req, reply) => {
 *     return { result: "data", payer: req.x402Payment?.payer };
 *   });
 *
 * The payment receipt is on `request.x402Payment` after the
 * preHandler resolves.
 */

import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { runProtocol, validateOptions } from "./core.js";
import type { MiddlewareOptions, PaymentReceipt } from "./types.js";

// Fastify type augmentation — same purpose as the Express one.
declare module "fastify" {
  interface FastifyRequest {
    x402Payment?: PaymentReceipt;
  }
}

export function createFastifyPreHandler(
  opts: MiddlewareOptions,
): preHandlerHookHandler {
  validateOptions(opts);
  return async function x402PreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const resourceUrl = buildResourceUrl(request);
    const paymentHeader = readSingleHeader(
      request.headers["x-payment"] as string | string[] | undefined,
    );
    const idempotencyKey = readSingleHeader(
      request.headers["idempotency-key"] as string | string[] | undefined,
    );

    const result = await runProtocol({
      opts,
      resourceUrl,
      paymentHeader,
      idempotencyKey,
    });
    if (result.kind === "accepted") {
      request.x402Payment = result.receipt;
      return;
    }
    reply
      .code(result.status)
      .header("Content-Type", "application/json")
      .header("Cache-Control", "no-store")
      .send(result.body);
  };
}

function readSingleHeader(
  value: string | string[] | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

function buildResourceUrl(request: FastifyRequest): string {
  // Fastify resolves protocol from the connection plus the proxy
  // headers if trustProxy is enabled — the protocol getter does the
  // right thing in both modes.
  const proto = request.protocol;
  const host =
    (request.headers["host"] as string | undefined) ?? "localhost";
  return `${proto}://${host}${request.url}`;
}
