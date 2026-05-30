/**
 * Express adapter. Mount the returned middleware on the route(s)
 * you want to gate behind payment:
 *
 *   import express from "express";
 *   import { createExpressMiddleware } from "@suverselabs/x402-server/express";
 *
 *   const app = express();
 *   app.use("/paid",
 *     createExpressMiddleware({
 *       apiKey: process.env.SUVERSE_PAY_API_KEY!,
 *       facilitator: "https://facilitator.suverse.io",
 *       acceptedPayments: [{
 *         scheme: "exact",
 *         network: "eip155:8453",
 *         asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
 *         payTo: "0x...",
 *         maxAmountRequired: "100000",
 *       }],
 *     }),
 *   );
 *
 * After a successful payment the receipt is on `req.x402Payment`.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { runProtocol, validateOptions } from "./core.js";
import type { MiddlewareOptions, PaymentReceipt } from "./types.js";

// Global augmentation of Express.Request — lets the seller's
// handler use `req.x402Payment` without a cast. Optional because
// not every request goes through the middleware. We target the
// Express namespace (not express-serve-static-core) so this works
// without a direct devDep on @types/express-serve-static-core.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      x402Payment?: PaymentReceipt;
    }
  }
}

export function createExpressMiddleware(
  opts: MiddlewareOptions,
): RequestHandler {
  validateOptions(opts);
  return async function x402Middleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const resourceUrl = buildResourceUrl(req);
    const paymentHeader = readSingleHeader(req.headers["x-payment"]);
    const idempotencyKey = readSingleHeader(req.headers["idempotency-key"]);

    try {
      const result = await runProtocol({
        opts,
        resourceUrl,
        paymentHeader,
        idempotencyKey,
      });
      if (result.kind === "accepted") {
        req.x402Payment = result.receipt;
        next();
        return;
      }
      // challenge / rejected
      res.status(result.status);
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.send(JSON.stringify(result.body));
    } catch (err) {
      opts.logger?.error?.(
        `x402-server: middleware error: ${(err as Error).message}`,
      );
      next(err);
    }
  };
}

function readSingleHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

function buildResourceUrl(req: Request): string {
  // Reconstruct the absolute URL the client hit, honouring
  // X-Forwarded-* if Express's `trust proxy` is set. Use Host as
  // fallback when behind no proxy.
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ??
    (req.protocol || "http");
  const host = (req.headers["host"] as string | undefined) ?? "localhost";
  return `${proto}://${host}${req.originalUrl ?? req.url ?? "/"}`;
}
