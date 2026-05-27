import { z } from "zod";

const ConfigSchema = z.object({
  port: z.number().int().positive(),
  host: z.string().min(1),
  gatewayUrl: z.string().url(),
  // Optional in Phase 2 Sub-task 1 — only init_session works without it. From
  // Sub-task 5 onward (list_providers, pay_and_call, etc.) it becomes required.
  adminApiKey: z.string().min(1).optional(),
  sessionTimeoutMs: z.number().int().positive(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const env = process.env;
  return ConfigSchema.parse({
    port: Number(env.MCP_PORT ?? "3100"),
    host: env.MCP_HOST ?? "127.0.0.1",
    gatewayUrl: env.SUVERSE_PAY_GATEWAY_URL ?? "http://localhost:3000",
    adminApiKey: env.SUVERSE_PAY_ADMIN_KEY || undefined,
    sessionTimeoutMs:
      Number(env.MCP_SESSION_TIMEOUT_MINUTES ?? "30") * 60 * 1000,
  });
}
