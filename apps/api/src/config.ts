import { z } from "zod";

const NonEmpty = z.string().min(1);

export const ConfigSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  logLevel: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  apiPort: z.coerce.number().int().positive().default(3000),
  apiHost: NonEmpty.default("0.0.0.0"),

  /**
   * The plaintext admin API key clients send as `Authorization: Bearer
   * <key>`. We never store it — only its sha256 hash, which is what
   * lives in `api_keys.key_hash`. Bootstrap (Step 9) hashes the same
   * env var into that row.
   */
  adminApiKey: NonEmpty,

  databaseUrl: NonEmpty,
  redisUrl: NonEmpty,

  rateLimitMaxPerMinute: z.coerce.number().int().positive().default(120),

  cosmosPayBaseUrl: NonEmpty.default("http://localhost:8402"),

  coinbaseCdpApiKeyName: z.string().optional(),
  coinbaseCdpApiKeySecret: z.string().optional(),
  coinbaseCdpMonthlyHardCap: z.coerce.number().int().positive().default(5000),
  coinbaseCdpBaseUrl: z.string().optional(),

  // PayAI x402 facilitator (https://facilitator.payai.network).
  // Free tier accepts unauthenticated requests up to 10 000 settles/mo;
  // paid tier uses Basic auth with key id + secret. Both optional —
  // unset means PayAI is registered with the free-tier path (no auth
  // header sent). Set `payAiEnabled=false` to skip registration
  // entirely.
  payAiEnabled: z
    .union([z.boolean(), z.string().transform((v) => v === "true" || v === "1")])
    .default(true),
  payAiBaseUrl: z.string().optional(),
  payAiApiKeyId: z.string().optional(),
  payAiApiKeySecret: z.string().optional(),

  // Thirdweb Nexus x402 facilitator (https://nexus-api.thirdweb.com).
  // /supported + /health are open (so we can register and discover
  // without a key); /verify + /settle require an API key sent in the
  // `x-nexus-key` header. Set `thirdwebX402Enabled=false` to skip
  // registration entirely. `thirdwebX402ApiKey` defaults to unset —
  // the adapter still registers in capability-discovery-only mode and
  // routing skips it for /verify+/settle when there's no key.
  thirdwebX402Enabled: z
    .union([z.boolean(), z.string().transform((v) => v === "true" || v === "1")])
    .default(true),
  thirdwebX402BaseUrl: z.string().optional(),
  thirdwebX402ApiKey: z.string().optional(),
  thirdwebX402AuthHeader: z.string().optional(),

  // Binance x402 facilitator on BNB Chain (Phase 4 Block 2 Sub-task 7).
  // Binance Pay product; auth is HMAC-SHA512 with `BinancePay-*`
  // headers per `binance/binance-pay-signature-examples`. As of
  // 2026-05-29 Binance has not published a public x402 endpoint —
  // base URL defaults to the canonical Binance Pay merchant host and
  // path prefix is a best-guess matching their Pay API conventions
  // (`/binancepay/openapi/v1/...`). Override both once Binance
  // documents the exact mount point. Without keys, /verify and
  // /settle throw `unauthorized`; the adapter still registers so
  // operators see it in the dashboard.
  binanceX402Enabled: z
    .union([z.boolean(), z.string().transform((v) => v === "true" || v === "1")])
    .default(true),
  binanceX402BaseUrl: z.string().optional(),
  binanceX402PathPrefix: z.string().optional(),
  binanceX402ApiKey: z.string().optional(),
  binanceX402ApiSecret: z.string().optional(),

  // BofAI x402 facilitator (TRON + BSC). Open / no auth required;
  // default URL points at the BankOfAI hosted facilitator. Override
  // BOFAI_X402_BASE_URL to a self-hosted instance. Sub-task 8 — first
  // non-EVM, non-Solana, non-Cosmos route in the gateway.
  bofaiX402Enabled: z
    .union([z.boolean(), z.string().transform((v) => v === "true" || v === "1")])
    .default(true),
  bofaiX402BaseUrl: z.string().optional(),

  capabilityDiscoveryIntervalMs: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 60 * 60 * 1000),
  healthCheckIntervalMs: z.coerce.number().int().positive().default(30_000),
  // Phase 4 Block 1 Sub-task 4 — observability stack. Matches the
  // Prometheus scrape_interval (15s) so dashboards always see a fresh
  // value within a tick. Raise on busy deploys to reduce DB load.
  metricsRefreshIntervalMs: z.coerce.number().int().positive().default(15_000),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    apiPort: env.API_PORT,
    apiHost: env.API_HOST,
    adminApiKey: env.ADMIN_API_KEY,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    rateLimitMaxPerMinute: env.RATE_LIMIT_MAX_PER_MINUTE,
    cosmosPayBaseUrl: env.COSMOS_PAY_BASE_URL,
    coinbaseCdpApiKeyName: env.COINBASE_CDP_API_KEY_NAME,
    coinbaseCdpApiKeySecret: env.COINBASE_CDP_API_KEY_SECRET,
    coinbaseCdpMonthlyHardCap: env.COINBASE_CDP_MONTHLY_HARD_CAP,
    coinbaseCdpBaseUrl: env.COINBASE_CDP_BASE_URL,
    payAiEnabled: env.PAYAI_ENABLED,
    payAiBaseUrl: env.PAYAI_BASE_URL,
    payAiApiKeyId: env.PAYAI_API_KEY_ID,
    payAiApiKeySecret: env.PAYAI_API_KEY_SECRET,
    thirdwebX402Enabled: env.THIRDWEB_X402_ENABLED,
    thirdwebX402BaseUrl: env.THIRDWEB_X402_BASE_URL,
    thirdwebX402ApiKey: env.THIRDWEB_X402_API_KEY,
    thirdwebX402AuthHeader: env.THIRDWEB_X402_AUTH_HEADER,
    binanceX402Enabled: env.BINANCE_X402_ENABLED,
    binanceX402BaseUrl: env.BINANCE_X402_BASE_URL,
    binanceX402PathPrefix: env.BINANCE_X402_PATH_PREFIX,
    binanceX402ApiKey: env.BINANCE_X402_API_KEY,
    binanceX402ApiSecret: env.BINANCE_X402_API_SECRET,
    bofaiX402Enabled: env.BOFAI_X402_ENABLED,
    bofaiX402BaseUrl: env.BOFAI_X402_BASE_URL,
    capabilityDiscoveryIntervalMs: env.CAPABILITY_DISCOVERY_INTERVAL_MS,
    healthCheckIntervalMs: env.HEALTH_CHECK_INTERVAL_MS,
    metricsRefreshIntervalMs: env.METRICS_REFRESH_INTERVAL_MS,
  });
}
