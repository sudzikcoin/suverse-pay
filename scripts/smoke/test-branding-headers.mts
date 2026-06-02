#!/usr/bin/env tsx
/**
 * Smoke test for the X-Suverse-* response branding rolled out 2026-06-02.
 * Pays three settled-200 x402 calls against allowlisted slugs:
 *   coinbase-btc-spot      ($0.001 USDC on Base)
 *   cosmos-validator-stats ($0.05  USDC on Base)
 *   solana-tx-decoder      ($0.20  USDC on Base)
 *
 * Total expected spend: ~$0.251 from PAYER_BASE_PRIVATE_KEY_PATH.
 *
 * Each call prints:
 *   - x402 transaction hash
 *   - All X-Suverse-* headers received
 *   - Top-level response body (pretty-printed, truncated to 600 chars)
 *
 * Run from /home/govhub/suverse-pay.
 */

import { readFileSync } from "node:fs";
import { SuverseClient } from "../../node_modules/.pnpm/@suverselabs+x402-client@0.1.0_typescript@5.9.3_zod@3.25.76/node_modules/@suverselabs/x402-client/dist/index.js";

const KEY_PATH =
  process.env["PAYER_BASE_PRIVATE_KEY_PATH"] ??
  "/etc/suverse-pay/base-payer.key";

const BASE = process.env["SMOKE_PROXY_BASE"] ?? "https://proxy.suverse.io/v1/data";

interface Spec {
  slug: string;
  body: Record<string, unknown> | null;
  method: "GET" | "POST";
}

const SPECS: Spec[] = [
  { slug: "coinbase-btc-spot", body: null, method: "GET" },
  {
    slug: "cosmos-validator-stats",
    method: "POST",
    body: {
      chain: "cosmoshub",
      validator: "cosmosvaloper1qphf0ferqcch0jca9hlqfm3x0eds3dpkcvpafp",
    },
  },
  {
    slug: "solana-tx-decoder",
    method: "POST",
    body: { signature: "__FETCH__" },
  },
];

function readHexKey(path: string): `0x${string}` {
  const raw = readFileSync(path, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`unexpected key shape in ${path}`);
  }
  return raw as `0x${string}`;
}

async function fetchFreshSolanaSignature(): Promise<string> {
  // Helius if available, else public RPC. Same pattern as
  // test-suverse-tx-decoder.mts.
  const HELIUS_KEY = process.env["HELIUS_API_KEY"] ?? "";
  const SOLANA_RPC = HELIUS_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
    : "https://api.mainnet-beta.solana.com";
  const res = await fetch(SOLANA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", { limit: 1 }],
    }),
  });
  const json = (await res.json()) as {
    result?: Array<{ signature: string; err: unknown }>;
  };
  const first = json.result?.find((r) => !r.err);
  if (!first) throw new Error("no fresh Solana signature returned");
  return first.signature;
}

async function callOne(client: InstanceType<typeof SuverseClient>, spec: Spec) {
  const url = `${BASE}/${spec.slug}`;
  // Substitute the live Solana signature in the body, if needed.
  let body = spec.body;
  if (body && body["signature"] === "__FETCH__") {
    body = { signature: await fetchFreshSolanaSignature() };
  }

  console.log(`\n=== ${spec.method} ${url} ===`);
  const t0 = Date.now();
  try {
    const init: Record<string, unknown> = { method: spec.method };
    if (body) {
      init["headers"] = { "content-type": "application/json" };
      init["body"] = JSON.stringify(body);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await client.fetch(url, init as any);
    const dtMs = Date.now() - t0;
    console.log(`status=${result.response.status} latencyMs=${dtMs}`);
    if (result.receipt) {
      console.log(
        `payment: network=${result.receipt.network} tx=${result.receipt.transaction}`,
      );
    }
    // Dump every X-Suverse-* header
    console.log("\nbranding headers:");
    let any = false;
    result.response.headers.forEach((v: string, k: string) => {
      if (k.toLowerCase().startsWith("x-suverse-")) {
        console.log(`  ${k}: ${v}`);
        any = true;
      }
    });
    if (!any) console.log("  (none — branding skipped or not enabled)");

    const data = result.data;
    const dataStr = JSON.stringify(data, null, 2);
    console.log("\nbody (first 600 chars):");
    console.log(dataStr.length > 600 ? dataStr.slice(0, 600) + "…" : dataStr);
  } catch (err) {
    const dtMs = Date.now() - t0;
    console.error(`FAIL in ${dtMs}ms: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const evmKey = readHexKey(KEY_PATH);
  const client = new SuverseClient({ wallets: { evm: evmKey } });
  for (const spec of SPECS) {
    await callOne(client, spec);
  }
}

await main();
