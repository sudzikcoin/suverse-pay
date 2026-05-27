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

  capabilityDiscoveryIntervalMs: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 60 * 60 * 1000),
  healthCheckIntervalMs: z.coerce.number().int().positive().default(30_000),
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
    capabilityDiscoveryIntervalMs: env.CAPABILITY_DISCOVERY_INTERVAL_MS,
    healthCheckIntervalMs: env.HEALTH_CHECK_INTERVAL_MS,
  });
}
