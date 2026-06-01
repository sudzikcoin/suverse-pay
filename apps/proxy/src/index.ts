/**
 * Boot entrypoint for the proxy service. Reads config from env,
 * opens a Postgres pool, builds the Fastify app, listens.
 *
 * Required env:
 *   - DATABASE_URL          postgres connection string
 *   - PROXY_HEADER_KEY      base64-encoded 32-byte AES master key
 *   - FACILITATOR_URL       e.g. https://facilitator.suverse.io
 *   - PROXY_RESOURCE_API_KEY  sup_live_... key the proxy uses to
 *                             talk to the facilitator (this is the
 *                             "system" key for the proxy's own
 *                             /facilitator/settle calls — same shape
 *                             as any seller's key, just owned by the
 *                             proxy operator)
 * Optional env:
 *   - PORT                       default 3003
 *   - HOST                       default 0.0.0.0
 *   - REDIS_URL                  enables shared rate-limit state
 *   - RATE_LIMIT_PER_MIN         default 120
 *   - LOG_LEVEL                  default info
 *   - HEALTH_CHECK_TIMEOUT_MS    pre-charge upstream probe budget,
 *                                default 3000
 */

import { readFileSync } from "node:fs";
import pg from "pg";
import { SuverseClient } from "@suverselabs/x402-client";
import type { MultiChainWallets } from "@suverselabs/x402-client";
import { loadMasterKey } from "./crypto.js";
import { buildServer } from "./server.js";
import type {
  ServiceAddresses,
  ServiceWallets,
} from "./upstream-x402.js";
import {
  loadSwapSigner,
  Web3SolanaSwapChain,
  type SolanaSwapChain,
  type SwapSignerConfig,
} from "./swap.js";

async function main(): Promise<void> {
  const databaseUrl = required("DATABASE_URL");
  const facilitatorUrl = required("FACILITATOR_URL");
  const facilitatorApiKey = required("PROXY_RESOURCE_API_KEY");
  const masterKey = loadMasterKey();

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 16,
    idleTimeoutMillis: 30_000,
  });

  const healthCheckTimeoutMs = parsePositiveInt(
    process.env["HEALTH_CHECK_TIMEOUT_MS"],
  );

  const { wallets, addresses } = loadServiceWallets();
  const upstreamClient =
    Object.keys(wallets).length > 0
      ? new SuverseClient({ wallets: wallets as MultiChainWallets })
      : undefined;

  // SuVerse Swap: separate liquidity wallet, totally independent of
  // the upstream-x402 service wallets above. Optional; absence is
  // logged but does not abort boot.
  let swapSigner: SwapSignerConfig | undefined;
  let swapChain: SolanaSwapChain | undefined;
  let swapPublicBaseUrl: string | undefined;
  try {
    swapSigner = loadSwapSigner();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `proxy: failed to load swap signer — swap routes disabled: ${(err as Error).message}`,
    );
  }
  if (swapSigner) {
    const rpcUrl = resolveSolanaRpcUrl();
    if (rpcUrl) {
      swapChain = new Web3SolanaSwapChain({
        rpcUrl,
        secretKey: swapSigner.secretKey,
      });
      swapPublicBaseUrl =
        process.env["SWAP_PUBLIC_BASE_URL"] ?? "https://proxy.suverse.io";
    } else {
      // eslint-disable-next-line no-console
      console.error(
        "proxy: SWAP_SOLANA_* present but no Solana RPC (set HELIUS_API_KEY or SOLANA_RPC_URL) — swap routes disabled",
      );
      swapSigner = undefined;
    }
  }

  const app = await buildServer({
    pool,
    masterKey,
    facilitatorUrl,
    facilitatorApiKey,
    ...(process.env["REDIS_URL"]
      ? { redisUrl: process.env["REDIS_URL"] }
      : {}),
    rateLimitPerMin: Number(process.env["RATE_LIMIT_PER_MIN"] ?? 120),
    ...(healthCheckTimeoutMs !== undefined ? { healthCheckTimeoutMs } : {}),
    ...(upstreamClient !== undefined
      ? { upstreamX402Client: upstreamClient, upstreamServiceAddresses: addresses }
      : {}),
    ...(swapSigner && swapChain && swapPublicBaseUrl
      ? { swapSigner, swapChain, swapPublicBaseUrl }
      : {}),
  });

  const port = Number(process.env["PORT"] ?? 3003);
  const host = process.env["HOST"] ?? "0.0.0.0";

  await app.listen({ port, host });
  app.log.info(`proxy listening on ${host}:${port}`);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal} — shutting down`);
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

function required(name: string): string {
  const v = process.env[name];
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

/**
 * Read every configured service wallet keypair from disk. Each family
 * is optional — when neither SERVICE_<NS>_ADDRESS nor PRIVKEY_PATH is
 * set, the namespace is skipped. The proxy boots fine without any
 * service wallet; only upstream-x402-enabled rows will then fail at
 * request time (handler logs `no_service_client`).
 *
 * Solana keypair format: 64-byte JSON array, the canonical
 * `solana-keygen` output. We pass the raw Uint8Array to SuverseClient
 * so the buyer SDK can derive the public key itself.
 */
function loadServiceWallets(): {
  wallets: ServiceWallets;
  addresses: ServiceAddresses;
} {
  const wallets: ServiceWallets = {};
  const addresses: ServiceAddresses = {};

  const solAddr = process.env["SERVICE_SOLANA_ADDRESS"];
  const solPath = process.env["SERVICE_SOLANA_PRIVKEY_PATH"];
  if (solAddr && solPath) {
    try {
      const raw = JSON.parse(readFileSync(solPath, "utf8")) as number[];
      if (!Array.isArray(raw) || raw.length !== 64) {
        throw new Error(
          `expected 64-byte JSON array at ${solPath}, got length ${raw.length}`,
        );
      }
      wallets.solana = Uint8Array.from(raw);
      addresses.solana = solAddr;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `proxy: failed to load Solana service wallet from ${solPath}: ${(err as Error).message}`,
      );
    }
  }
  // (EVM / Cosmos / TRON wallets land here when added.)
  return { wallets, addresses };
}

/**
 * Pick a Solana RPC URL — explicit override wins, else Helius if the
 * key is configured, else undefined (caller skips swap wiring).
 */
function resolveSolanaRpcUrl(): string | undefined {
  const explicit = process.env["SOLANA_RPC_URL"];
  if (explicit && explicit.trim() !== "") return explicit;
  const heliusKey = process.env["HELIUS_API_KEY"];
  if (heliusKey && heliusKey.trim() !== "") {
    return `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
  }
  return undefined;
}

/** Parse an optional positive integer env var; return undefined on absence or junk. */
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("proxy: fatal boot error", err);
  process.exit(1);
});
