// One-shot indexing-settle on the now-paid /quote endpoints so CDP
// Bazaar wakes its crawler. Pays the cheapest non-zero amount (1
// atomic USDC = $0.000001) on whichever chains you flag.
//
// Usage:
//   SOLANA=1 BASE=1 \
//     PAYER_SOLANA_KEY_PATH=/etc/suverse-pay/service-solana.key \
//     PAYER_BASE_PRIVATE_KEY_PATH=/etc/suverse-pay/base-payer.key \
//     node --import tsx scripts/smoke/index-swap-quote-bazaar.mts
//
// The /quote work itself still runs after settle (Jupiter / LiFi
// call, DB insert, response shaping); we just don't follow through
// to /execute. The point is to fire one real CDP-routed settle on
// the /quote URL so /discovery picks it up.

import { readFileSync } from "node:fs";
import { SuverseClient } from "@suverselabs/x402-client";

const PROXY_BASE = process.env.SWAP_PROXY_BASE ?? "https://proxy.suverse.io";

const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const BASE_CAIP2 = "eip155:8453";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH_BASE = "0x4200000000000000000000000000000000000006";

interface IndexResult {
  network: string;
  durationMs: number;
  status: number;
  payment: {
    network: string;
    txHash: string | null;
    payer: string;
    payTo: string;
    amountAtomic: string;
  };
  bodyExcerpt: string;
}

async function indexSolana(): Promise<IndexResult> {
  const path = process.env.PAYER_SOLANA_KEY_PATH;
  if (!path) throw new Error("PAYER_SOLANA_KEY_PATH required");
  const arr = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(arr) || arr.length !== 64) {
    throw new Error("expected 64-byte JSON array at PAYER_SOLANA_KEY_PATH");
  }
  const client = new SuverseClient({
    wallets: { solana: new Uint8Array(arr) },
    preferences: { preferredNetwork: SOLANA_CAIP2 },
    signerOptions: {
      solana: { rpcEndpoint: "https://api.mainnet-beta.solana.com" },
    },
  });

  console.log("\n=== Solana /v1/swap/solana/quote — indexing settle ===");
  const t0 = Date.now();
  // Body: a real, gas-guard-passing USDC→BONK quote of $0.50. The
  // server will run Jupiter and return 200; we just discard the
  // quote_id since we don't follow through to /execute.
  const res = await client.fetch(`${PROXY_BASE}/v1/swap/solana/quote`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "User-Agent": "suverse-bazaar-index/1.0",
    },
    body: JSON.stringify({
      input_mint: SOLANA_USDC,
      output_mint: BONK_MINT,
      input_amount: "500000", // $0.50, clears forward floor ($0.20)
      slippage_bps: 100,
    }),
  });
  const ms = Date.now() - t0;
  const text =
    typeof res.data === "string"
      ? res.data
      : JSON.stringify(res.data).slice(0, 400);
  return {
    network: SOLANA_CAIP2,
    durationMs: ms,
    status: res.response.status,
    payment: {
      network: res.payment.network,
      txHash: res.payment.txHash ?? null,
      payer: res.payment.payer,
      payTo: res.payment.payTo,
      amountAtomic: res.payment.amount,
    },
    bodyExcerpt: text,
  };
}

async function indexBase(): Promise<IndexResult> {
  const path = process.env.PAYER_BASE_PRIVATE_KEY_PATH;
  if (!path) throw new Error("PAYER_BASE_PRIVATE_KEY_PATH required");
  const raw = readFileSync(path, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      "PAYER_BASE_PRIVATE_KEY_PATH must point at a hex-encoded 32-byte private key",
    );
  }
  const client = new SuverseClient({
    wallets: { evm: raw as `0x${string}` },
    preferences: { preferredNetwork: BASE_CAIP2 },
  });

  console.log("\n=== Base /v1/swap/base/quote — indexing settle ===");
  const t0 = Date.now();
  const res = await client.fetch(`${PROXY_BASE}/v1/swap/base/quote`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "User-Agent": "suverse-bazaar-index/1.0",
    },
    body: JSON.stringify({
      input_token: BASE_USDC,
      output_token: WETH_BASE,
      input_amount: "1500000", // $1.50, clears forward floor
      slippage_bps: 100,
    }),
  });
  const ms = Date.now() - t0;
  const text =
    typeof res.data === "string"
      ? res.data
      : JSON.stringify(res.data).slice(0, 400);
  return {
    network: BASE_CAIP2,
    durationMs: ms,
    status: res.response.status,
    payment: {
      network: res.payment.network,
      txHash: res.payment.txHash ?? null,
      payer: res.payment.payer,
      payTo: res.payment.payTo,
      amountAtomic: res.payment.amount,
    },
    bodyExcerpt: text,
  };
}

const runSolana = process.env.SOLANA === "1";
const runBase = process.env.BASE === "1";
if (!runSolana && !runBase) {
  console.error("Set SOLANA=1 and/or BASE=1 to enable each chain's run");
  process.exit(2);
}

const results: IndexResult[] = [];
if (runSolana) results.push(await indexSolana());
if (runBase) results.push(await indexBase());
console.log("\n=== summary ===");
console.log(JSON.stringify(results, null, 2));
