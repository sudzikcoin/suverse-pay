import { z } from "zod";

const ConfigSchema = z.object({
  port: z.number().int().positive(),
  host: z.string().min(1),
  gatewayUrl: z.string().url(),
  // Required from Sub-task 5 on — every non-init tool calls the gateway,
  // and the gateway only accepts authenticated Bearer requests.
  adminApiKey: z.string().min(1),
  sessionTimeoutMs: z.number().int().positive(),
  /** Timeout for outbound calls to the resource server from pay_and_call. */
  externalCallTimeoutMs: z.number().int().positive(),
  /**
   * Solana RPC URLs used by pay_and_call to fetch a recent blockhash at
   * sign time. The signer-solana spec requires the caller to supply a
   * fresh blockhash; we never cache it because Solana drops them after
   * ~150 slots (~60 s).
   */
  solanaRpcUrlMainnet: z.string().url(),
  solanaRpcUrlDevnet: z.string().url(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const env = process.env;
  const adminKey = env.SUVERSE_PAY_ADMIN_KEY;
  if (adminKey === undefined || adminKey.length === 0) {
    throw new Error(
      "SUVERSE_PAY_ADMIN_KEY is required: the MCP server authenticates to " +
        "the suverse-pay gateway with this admin API key. " +
        "Set it in the MCP server's environment — it is NOT exposed to MCP clients.",
    );
  }
  return ConfigSchema.parse({
    port: Number(env.MCP_PORT ?? "3100"),
    host: env.MCP_HOST ?? "127.0.0.1",
    gatewayUrl: env.SUVERSE_PAY_GATEWAY_URL ?? "http://localhost:3000",
    adminApiKey: adminKey,
    sessionTimeoutMs:
      Number(env.MCP_SESSION_TIMEOUT_MINUTES ?? "30") * 60 * 1000,
    externalCallTimeoutMs: Number(env.MCP_EXTERNAL_CALL_TIMEOUT_MS ?? "15000"),
    solanaRpcUrlMainnet:
      env.SUVERSE_PAY_SOLANA_RPC_URL_MAINNET ?? "https://api.mainnet-beta.solana.com",
    solanaRpcUrlDevnet:
      env.SUVERSE_PAY_SOLANA_RPC_URL_DEVNET ?? "https://api.devnet.solana.com",
  });
}
