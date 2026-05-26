import { GatewayError, ProviderError } from "@suverse-pay/core-types";
import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Global error handler. Normalizes:
 *   - ZodError → 400 invalid_request (with field-level details)
 *   - GatewayError → its declared httpStatus + code
 *   - ProviderError → 502 with provider's error code (a provider call
 *     reached the route layer untranslated; treat as upstream failure)
 *   - Fastify validation / 4xx errors → pass through with the code
 *     fastify set
 *   - Everything else → 500 unexpected_settle_error (closest match in
 *     our enum; the message is generic to avoid leaking internals)
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof ZodError) {
      const body: ErrorBody = {
        error: {
          code: "invalid_request",
          message: "request body failed validation",
          details: err.flatten(),
        },
      };
      reply.code(400).send(body);
      return;
    }

    if (err instanceof GatewayError) {
      reply
        .code(err.httpStatus)
        .send({ error: { code: err.code, message: err.message } });
      return;
    }

    if (err instanceof ProviderError) {
      reply
        .code(502)
        .send({
          error: {
            code: err.code,
            message: err.message,
            details: err.providerId
              ? { providerId: err.providerId }
              : undefined,
          },
        });
      return;
    }

    const status = (err as FastifyError).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      reply.code(status).send({
        error: {
          code:
            (err as FastifyError).code !== undefined
              ? mapFastifyCode((err as FastifyError).code!)
              : "invalid_request",
          message: err.message,
        },
      });
      return;
    }

    req.log.error({ err }, "unhandled error in request");
    reply.code(500).send({
      error: {
        code: "unexpected_settle_error",
        message: "internal server error",
      },
    });
  });
}

function mapFastifyCode(code: string): string {
  if (code.startsWith("FST_ERR_VALIDATION")) return "invalid_request";
  if (code.startsWith("FST_ERR_RATE_LIMIT")) return "rate_limited";
  if (code === "FST_ERR_NOT_FOUND") return "not_found";
  return "invalid_request";
}
