// E2E smoke for the OATP-wrap experiment (Stage 5 of the OATP-wrap
// playbook). Verifies the full upstream-x402 flow:
//
//   buyer (Base USDC)  →  proxy.suverse.io/v1/data/solana-tx-decoder
//   proxy (Solana USDC) → api.oatp.cc/tools/tx_explainer
//
// Reads the Claude-owned Base buyer key from disk (chmod-600,
// path-via-env, never inline — see CLAUDE-managed memory entry
// `reference-base-buyer-wallet`). Pays through the unified
// SuverseClient buyer SDK exactly the way an external customer would.
//
// Single-endpoint by default; pass --endpoint <slug> to drive one of
// the other two OATP wraps (solana-tx-simulator, spl-token-safety-check).
//
// Env:
//   PAYER_BASE_PRIVATE_KEY_PATH   absolute path to 0x-prefixed 64-hex
//                                 secret. Required.
//   PAYER_BASE_PRIVATE_KEY        alternative — inline 0x-prefixed key.
//                                 Either-or; path wins if both set.
//   PROXY_BASE_URL                override proxy host (default
//                                 https://proxy.suverse.io).

import { readFileSync } from "node:fs";
import { SuverseClient } from "@suverselabs/x402-client";

const BASE_NETWORK = "eip155:8453";

interface Endpoint {
  readonly slug: string;
  readonly priceUsdc: string;
  readonly body: Record<string, unknown>;
}

const ENDPOINTS: Record<string, Endpoint> = {
  "solana-tx-decoder": {
    slug: "solana-tx-decoder",
    priceUsdc: "0.20",
    body: {
      // Real, finalized mainnet tx — one of our service wallet's own
      // outbound x402 payments to OATP from earlier in this session.
      // Guaranteed to be within OATP's RPC retention window.
      signature:
        "2bgYg6fmhxQj5SSd2Rt85TuBvsimkzfdNDc8sBh1Y81YAXobnu42jB2eL853GCoKUqBXpAvrdTGbwkNWUTz4uscT",
    },
  },
  "solana-tx-simulator": {
    slug: "solana-tx-simulator",
    priceUsdc: "0.40",
    body: {
      // Minimal placeholder; sim will likely report a transaction-level
      // error but the upstream call itself returns 200 either way.
      transaction:
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
  },
  "spl-token-safety-check": {
    slug: "spl-token-safety-check",
    priceUsdc: "1.00",
    body: { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" }, // BONK
  },
};

function loadKey(): `0x${string}` {
  const path = process.env.PAYER_BASE_PRIVATE_KEY_PATH;
  if (path) {
    const raw = readFileSync(path, "utf8").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
      throw new Error(
        `PAYER_BASE_PRIVATE_KEY_PATH must point at a 0x-prefixed 64-hex file (got ${raw.length} chars)`,
      );
    }
    return raw as `0x${string}`;
  }
  const inline = process.env.PAYER_BASE_PRIVATE_KEY;
  if (inline && /^0x[0-9a-fA-F]{64}$/.test(inline)) {
    return inline as `0x${string}`;
  }
  throw new Error(
    "Set PAYER_BASE_PRIVATE_KEY_PATH (preferred) or PAYER_BASE_PRIVATE_KEY",
  );
}

function pickEndpoint(): Endpoint {
  const flagIdx = process.argv.indexOf("--endpoint");
  const slug =
    flagIdx >= 0 && flagIdx + 1 < process.argv.length
      ? process.argv[flagIdx + 1]
      : "solana-tx-decoder";
  const ep = ENDPOINTS[slug];
  if (!ep) {
    throw new Error(
      `unknown endpoint ${slug}; pick one of: ${Object.keys(ENDPOINTS).join(", ")}`,
    );
  }
  return ep;
}

async function main(): Promise<void> {
  const ep = pickEndpoint();
  const proxyBase = process.env.PROXY_BASE_URL ?? "https://proxy.suverse.io";
  const url = `${proxyBase}/v1/data/${ep.slug}`;
  const privateKey = loadKey();

  const client = new SuverseClient({
    wallets: { evm: privateKey },
    preferences: { preferredNetwork: BASE_NETWORK },
  });

  console.log(`▶ ${ep.slug} (price $${ep.priceUsdc}) — paying via Base`);
  const t0 = Date.now();
  const result = await client.fetch<unknown>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ep.body),
  });
  const elapsedMs = Date.now() - t0;
  console.log(`✓ HTTP 200 in ${elapsedMs}ms`);
  console.log(`  buyer→merchant tx (Base): ${result.payment.txHash ?? "(none)"}`);
  console.log(`  paid: ${result.payment.amount} atomic USDC on ${result.payment.network}`);
  console.log(`  upstream response (first 600 chars):`);
  const dataStr =
    typeof result.data === "string"
      ? result.data
      : JSON.stringify(result.data, null, 2);
  console.log(dataStr.slice(0, 600) + (dataStr.length > 600 ? " …" : ""));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("FAIL:", (err as Error).message);
  process.exit(1);
});
