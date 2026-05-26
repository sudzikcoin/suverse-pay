import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { ServerContext } from "./context.js";
import { registerAuth } from "./plugins/auth.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerIdempotency } from "./plugins/idempotency.js";
import { registerRateLimit } from "./plugins/rate-limit.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerMetricsRoute } from "./routes/metrics.js";
import { registerPaymentsRoute } from "./routes/payments.js";
import { registerProvidersRoute } from "./routes/providers.js";
import { registerQuoteRoute } from "./routes/quote.js";
import { registerSettleRoute } from "./routes/settle.js";
import { registerVerifyRoute } from "./routes/verify.js";

export interface BuildServerOptions {
  ctx: ServerContext;
  /**
   * Redis instance for the rate-limit plugin. Pass null for tests
   * that don't need rate limiting (the plugin falls back to in-memory).
   */
  redis: Redis | null;
  /** Used by index.ts for production logging; tests can pass false. */
  enableLogger?: boolean;
}

/**
 * Builds a Fastify app wired to the supplied ServerContext. Does NOT
 * call `listen()` — `index.ts` does that. Tests use this directly
 * with `app.inject(...)`.
 */
export async function buildServer(
  opts: BuildServerOptions,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      opts.enableLogger === false
        ? false
        : {
            level: opts.ctx.config.logLevel,
            transport:
              opts.ctx.config.nodeEnv === "development"
                ? { target: "pino-pretty", options: { colorize: true } }
                : undefined,
          },
    disableRequestLogging: opts.enableLogger === false,
    trustProxy: true,
  });

  registerErrorHandler(app);
  registerIdempotency(app);
  registerAuth(app, { config: opts.ctx.config });
  await registerRateLimit(app, { config: opts.ctx.config, redis: opts.redis });

  registerHealthRoute(app);
  registerProvidersRoute(app, opts.ctx);
  registerQuoteRoute(app, opts.ctx);
  registerVerifyRoute(app, opts.ctx);
  registerSettleRoute(app, opts.ctx);
  registerPaymentsRoute(app, opts.ctx);
  registerMetricsRoute(app, opts.ctx);

  return app;
}
