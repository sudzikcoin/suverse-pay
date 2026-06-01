// E2E smoke for the four new Helius-backed first-party endpoints.
// Pays each from the Claude-owned Base buyer key, prints the settle tx
// hash and a slice of the response so the operator can eyeball
// "looks like real Helius data" without paginating through hundreds
// of bytes in the terminal.
//
// All four endpoints share an accepts list — Base USDC is the cheapest
// path that doesn't burn a Solana SPL rent. Total cost: $0.21.
//
// Env:
//   PAYER_BASE_PRIVATE_KEY_PATH   absolute path to 0x-prefixed 64-hex
//                                 secret. Required.
//   PROXY_BASE_URL                override (default proxy.suverse.io).

import { readFileSync } from "node:fs";
import { SuverseClient } from "@suverselabs/x402-client";

const BASE_NETWORK = "eip155:8453";

interface Endpoint {
  readonly slug: string;
  readonly priceUsdc: string;
  readonly body: Record<string, unknown>;
}

const ENDPOINTS: Endpoint[] = [
  {
    slug: "suverse-solana-tx-simulator",
    priceUsdc: "0.10",
    body: {
      // A bare zero-buffer is rejected by Helius's RPC at the sanitize
      // stage (-32602 invalid transaction); the handler maps that to
      // 400 simulation_rpc_error, which is itself a valid proof that
      // the proxy → handler → Helius wiring works end-to-end. Swap in
      // a freshly-serialized tx if you want a 200 success run.
      transaction:
        "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
  },
  {
    slug: "suverse-solana-priority-fee",
    priceUsdc: "0.01",
    // Empty body → global estimate.
    body: {},
  },
  {
    slug: "suverse-nft-metadata",
    priceUsdc: "0.05",
    // Real Mad Lads NFT — verified Helius DAS hit before checking in.
    // F9Lw3ki3… (the "collection" address that floats around in
    // docs) isn't a getAsset target; this is an actual edition mint.
    body: { mint: "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w" },
  },
  {
    slug: "suverse-wallet-history",
    priceUsdc: "0.05",
    // Jupiter aggregator wallet — guaranteed busy, recent txs.
    body: { address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", limit: 3 },
  },
];

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

async function run(ep: Endpoint, client: SuverseClient, proxyBase: string): Promise<{
  slug: string;
  status: "ok" | "fail";
  txHash: string | null;
  amount: string | null;
  network: string | null;
  responseValid: boolean;
  preview: string;
  errorMessage?: string;
}> {
  const url = `${proxyBase}/v1/data/${ep.slug}`;
  console.log(`\n▶ ${ep.slug} (price $${ep.priceUsdc})`);
  const t0 = Date.now();
  try {
    const result = await client.fetch<unknown>(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ep.body),
    });
    const elapsedMs = Date.now() - t0;
    const dataStr =
      typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data);
    const responseValid = dataStr.length > 0 && dataStr !== "null";
    console.log(`  ✓ HTTP 200 in ${elapsedMs}ms`);
    console.log(`  settle tx (Base): ${result.payment.txHash ?? "(none)"}`);
    console.log(`  paid: ${result.payment.amount} atomic on ${result.payment.network}`);
    console.log(`  response preview: ${dataStr.slice(0, 300)}${dataStr.length > 300 ? " …" : ""}`);
    return {
      slug: ep.slug,
      status: "ok",
      txHash: result.payment.txHash ?? null,
      amount: result.payment.amount ?? null,
      network: result.payment.network ?? null,
      responseValid,
      preview: dataStr.slice(0, 120),
    };
  } catch (err) {
    const msg = (err as Error).message;
    console.log(`  ✗ FAIL: ${msg}`);
    return {
      slug: ep.slug,
      status: "fail",
      txHash: null,
      amount: null,
      network: null,
      responseValid: false,
      preview: "",
      errorMessage: msg,
    };
  }
}

async function main(): Promise<void> {
  const proxyBase = process.env.PROXY_BASE_URL ?? "https://proxy.suverse.io";
  const privateKey = loadKey();
  const client = new SuverseClient({
    wallets: { evm: privateKey },
    preferences: { preferredNetwork: BASE_NETWORK },
  });

  const results: Awaited<ReturnType<typeof run>>[] = [];
  for (const ep of ENDPOINTS) {
    results.push(await run(ep, client, proxyBase));
  }

  console.log("\n────────────────────────────────────────────────");
  console.log("Summary");
  console.log("────────────────────────────────────────────────");
  for (const r of results) {
    const mark = r.status === "ok" ? "✓" : "✗";
    console.log(
      `${mark} ${r.slug}  tx=${r.txHash ?? "-"}  responseValid=${r.responseValid}`,
    );
  }
  const ok = results.filter((r) => r.status === "ok").length;
  console.log(`\n${ok}/${results.length} settled`);
  if (ok < results.length) process.exit(1);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("FATAL:", (err as Error).message);
  process.exit(1);
});
