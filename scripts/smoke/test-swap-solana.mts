// Real smoke: USDC → BONK on Solana mainnet via the SuVerse Swap.
//
// Two-step flow:
//   1. POST /v1/swap/solana/quote — free; returns quote_id +
//      total_cost + x402_pay_url.
//   2. POST x402_pay_url with payment via @suverselabs/x402-client —
//      pays total_cost, server runs the Jupiter swap with our
//      liquidity wallet, transfers output BONK to the buyer's
//      Solana payer address.
//
// PAYER_SOLANA_KEY_PATH env: path to a 64-byte JSON array (the
// secret key produced by `solana-keygen` / `Keypair.fromSecretKey`).
// The same wallet shape as the existing 4-proxies-solana smoke.

import { readFileSync } from "node:fs";
import { SuverseClient } from "@suverselabs/x402-client";

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const PROXY_BASE =
  process.env.SWAP_PROXY_BASE ?? "https://proxy.suverse.io";
const INPUT_AMOUNT = process.env.SWAP_INPUT_AMOUNT ?? "500000"; // 0.5 USDC
const SLIPPAGE_BPS = Number(process.env.SWAP_SLIPPAGE_BPS ?? "100");

const secretPath = process.env.PAYER_SOLANA_KEY_PATH;
if (!secretPath) {
  console.error(
    "ERROR: PAYER_SOLANA_KEY_PATH env required (path to 64-byte JSON array).",
  );
  process.exit(2);
}
const arr = JSON.parse(readFileSync(secretPath, "utf8"));
if (!Array.isArray(arr) || arr.length !== 64) {
  console.error("ERROR: expected 64-byte JSON array at PAYER_SOLANA_KEY_PATH.");
  process.exit(2);
}
const secret = new Uint8Array(arr);

const client = new SuverseClient({
  wallets: { solana: secret },
  preferences: { preferredNetwork: SOLANA_MAINNET },
  signerOptions: {
    solana: {
      rpcEndpoint: "https://api.mainnet-beta.solana.com",
    },
  },
});

// ---- Step 1: fetch a free quote ----
console.log("=== step 1: POST /v1/swap/solana/quote ===");
const quoteRes = await fetch(`${PROXY_BASE}/v1/swap/solana/quote`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    input_mint: USDC_MINT,
    output_mint: BONK_MINT,
    input_amount: INPUT_AMOUNT,
    slippage_bps: SLIPPAGE_BPS,
  }),
});
if (!quoteRes.ok) {
  const text = await quoteRes.text();
  console.error(`quote failed http=${quoteRes.status} body=${text}`);
  process.exit(1);
}
const quote = await quoteRes.json();
console.log(JSON.stringify(quote, null, 2));

// ---- Step 2: execute via x402 ----
console.log(`\n=== step 2: POST ${quote.x402_pay_url} (x402 paid) ===`);
const start = Date.now();
let exec;
try {
  exec = await client.fetch(quote.x402_pay_url, {
    method: "POST",
    headers: {
      "User-Agent": "suverse-pay-swap-smoke/1.0",
      "content-type": "application/json",
    },
    body: "{}", // body unused by server; quote_id is in the URL
  });
} catch (err) {
  console.error(
    "execute failed:",
    err?.code ?? "",
    err?.message ?? String(err),
  );
  if (err?.cause) console.error("cause:", err.cause);
  process.exit(1);
}
const ms = Date.now() - start;

console.log(JSON.stringify(
  {
    durationMs: ms,
    status: exec.response.status,
    payment: {
      network: exec.payment.network,
      txHash: exec.payment.txHash,
      payer: exec.payment.payer,
      payTo: exec.payment.payTo,
      amountAtomic: exec.payment.amount,
    },
    body: exec.data,
  },
  null,
  2,
));
