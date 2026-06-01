// E2E smoke for the 10 new TA / perp / tradfi endpoints (3 TA on
// Binance klines, 2 Binance futures, 1 DeFiLlama stablecoins, 2
// Yahoo stocks, 2 Frankfurter forex).
//
// Total cost: 6×$0.01 + 2×$0.005 + 1×$0.005 + 1×$0.01 = $0.085 USDC.
//
// Env:
//   PAYER_BASE_PRIVATE_KEY_PATH   0x-prefixed 64-hex secret file.
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
  { slug: "suverse-ta-rsi", priceUsdc: "0.01", body: { symbol: "BTCUSDT", interval: "1h" } },
  { slug: "suverse-ta-macd", priceUsdc: "0.01", body: { symbol: "BTCUSDT", interval: "1h" } },
  { slug: "suverse-ta-moving-averages", priceUsdc: "0.01", body: { symbol: "BTCUSDT", interval: "1d" } },
  { slug: "suverse-perp-open-interest", priceUsdc: "0.01", body: { symbol: "BTCUSDT" } },
  { slug: "suverse-perp-funding-batch", priceUsdc: "0.01", body: { symbols: ["BTCUSDT", "ETHUSDT"] } },
  { slug: "suverse-stablecoin-supply", priceUsdc: "0.01", body: {} },
  { slug: "suverse-stock-quote", priceUsdc: "0.005", body: { symbol: "AAPL" } },
  { slug: "suverse-stock-batch-quotes", priceUsdc: "0.01", body: { symbols: ["AAPL", "GOOGL", "TSLA"] } },
  { slug: "suverse-forex-rates", priceUsdc: "0.005", body: { base: "USD", symbols: ["EUR", "GBP"] } },
  { slug: "suverse-forex-historical", priceUsdc: "0.01", body: { date: "2026-01-15", base: "USD", symbol: "EUR" } },
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
  throw new Error("Set PAYER_BASE_PRIVATE_KEY_PATH (preferred) or PAYER_BASE_PRIVATE_KEY");
}

interface SmokeResult {
  slug: string;
  status: "ok" | "fail";
  txHash: string | null;
  amount: string | null;
  network: string | null;
  responseValid: boolean;
  errorMessage?: string;
}

async function run(ep: Endpoint, client: SuverseClient, proxyBase: string): Promise<SmokeResult> {
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
    const dataStr = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
    const responseValid = dataStr.length > 2 && dataStr !== "null";
    console.log(`  ✓ HTTP 200 in ${elapsedMs}ms`);
    console.log(`  settle tx (Base): ${result.payment.txHash ?? "(none)"}`);
    console.log(`  paid: ${result.payment.amount} atomic on ${result.payment.network}`);
    console.log(`  response preview: ${dataStr.slice(0, 350)}${dataStr.length > 350 ? " …" : ""}`);
    return {
      slug: ep.slug,
      status: "ok",
      txHash: result.payment.txHash ?? null,
      amount: result.payment.amount ?? null,
      network: result.payment.network ?? null,
      responseValid,
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

  const results: SmokeResult[] = [];
  for (const ep of ENDPOINTS) {
    results.push(await run(ep, client, proxyBase));
  }

  console.log("\n────────────────────────────────────────────────");
  console.log("Summary");
  console.log("────────────────────────────────────────────────");
  for (const r of results) {
    const mark = r.status === "ok" ? "✓" : "✗";
    console.log(`${mark} ${r.slug.padEnd(34)}  tx=${r.txHash ?? "-"}  responseValid=${r.responseValid}`);
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
