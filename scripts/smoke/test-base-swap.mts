#!/usr/bin/env tsx
/**
 * Real $0.40 USDC -> WETH swap on Base via the new SuVerse Base swap
 * (LiFi-routed). Buyer wallet is the standard Claude-owned
 * PAYER_BASE_PRIVATE_KEY_PATH (0x3869dE7597bDEa0172B97143f3eed806D8b84bf3).
 *
 * Two-step flow:
 *   1. POST /v1/swap/base/quote      (FREE) -> quote_id + total_cost
 *   2. POST /v1/swap/base/execute/{id} via SuverseClient.fetch() which
 *      handles the x402 EIP-3009 signature dance for USDC on Base.
 *
 * Verifies:
 *   - buyer USDC delta == quoted total_cost
 *   - buyer WETH delta == returned output_amount
 *   - three on-chain txs (approve / swap / transfer) confirmed
 */

import { readFileSync } from "node:fs";
import { SuverseClient } from "../../node_modules/.pnpm/@suverselabs+x402-client@0.1.0_typescript@5.9.3_zod@3.25.76/node_modules/@suverselabs/x402-client/dist/index.js";

const KEY_PATH =
  process.env["PAYER_BASE_PRIVATE_KEY_PATH"] ??
  "/etc/suverse-pay/base-payer.key";
const PROXY_BASE = process.env["PROXY_BASE"] ?? "https://proxy.suverse.io";
const RPC = "https://mainnet.base.org";

const BUYER = "0x3869dE7597bDEa0172B97143f3eed806D8b84bf3";
const SWAP_WALLET = "0x4261701A4dDf4625EBfA80CEefB5B3B2b5453B2E";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";

const INPUT_AMOUNT = process.env["SWAP_INPUT_USDC_ATOMIC"] ?? "100000"; // default 0.10 USDC
const SLIPPAGE_BPS = 100;

function readHexKey(path: string): `0x${string}` {
  const raw = readFileSync(path, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`unexpected key shape in ${path}`);
  }
  return raw as `0x${string}`;
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await res.json()) as { result: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function erc20Balance(token: string, owner: string): Promise<bigint> {
  const data =
    "0x70a08231" + "000000000000000000000000" + owner.toLowerCase().slice(2);
  const r = await rpcCall<string>("eth_call", [
    { to: token, data },
    "latest",
  ]);
  return BigInt(r);
}

async function txReceipt(hash: string): Promise<{ status: string; blockNumber: string } | null> {
  return rpcCall("eth_getTransactionReceipt", [hash]);
}

async function main() {
  console.log(`▶ buyer:      ${BUYER}`);
  console.log(`▶ swap wlt:   ${SWAP_WALLET}`);
  const humanInput = (Number(INPUT_AMOUNT) / 1e6).toFixed(4);
  console.log(`▶ input:      ${INPUT_AMOUNT} atomic (${humanInput} USDC) → WETH`);
  console.log(`▶ slippage:   ${SLIPPAGE_BPS} bps\n`);

  // 1) Snapshot balances BEFORE
  const beforeBuyerUsdc = await erc20Balance(USDC, BUYER);
  const beforeBuyerWeth = await erc20Balance(WETH, BUYER);
  const beforeSwapUsdc = await erc20Balance(USDC, SWAP_WALLET);
  const beforeSwapWeth = await erc20Balance(WETH, SWAP_WALLET);
  console.log("Before:");
  console.log(`  buyer USDC: ${beforeBuyerUsdc}`);
  console.log(`  buyer WETH: ${beforeBuyerWeth}`);
  console.log(`  swap  USDC: ${beforeSwapUsdc}`);
  console.log(`  swap  WETH: ${beforeSwapWeth}\n`);

  // 2) Get quote
  const quoteUrl = `${PROXY_BASE}/v1/swap/base/quote`;
  const quoteRes = await fetch(quoteUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input_token: USDC,
      output_token: WETH,
      input_amount: INPUT_AMOUNT,
      slippage_bps: SLIPPAGE_BPS,
    }),
  });
  if (!quoteRes.ok) {
    throw new Error(`quote ${quoteRes.status}: ${await quoteRes.text()}`);
  }
  const quote = (await quoteRes.json()) as {
    quote_id: string;
    expected_output: string;
    total_cost: string;
    tool: string;
    x402_pay_url: string;
  };
  console.log(`Quote: id=${quote.quote_id} tool=${quote.tool}`);
  console.log(`  expected_output: ${quote.expected_output} WETH atomic`);
  console.log(`  total_cost:      ${quote.total_cost} USDC atomic`);
  console.log(`  pay url:         ${quote.x402_pay_url}\n`);

  // 3) Pay + execute via x402 client
  const evmKey = readHexKey(KEY_PATH);
  const client = new SuverseClient({
    wallets: { evm: evmKey },
    preferences: { preferredNetwork: "eip155:8453" },
  });

  console.log("▶ executing (sign + pay + swap, ~60s on-chain)…");
  const t0 = Date.now();
  const paid = await client.fetch(quote.x402_pay_url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const dt = Date.now() - t0;
  console.log(`▶ done in ${dt}ms (status ${paid.response.status})\n`);

  const data = paid.data as Record<string, unknown>;
  console.log("Response body:");
  console.log(JSON.stringify(data, null, 2));
  console.log("");
  console.log("Inbound x402 payment:");
  console.log(`  network: ${paid.payment?.network}`);
  console.log(`  amount:  ${paid.payment?.amount}`);
  console.log(`  txHash:  ${paid.payment?.txHash}\n`);

  if (paid.response.status !== 200) {
    console.error("✗ execute did not return 200 — aborting verification");
    process.exit(1);
  }

  // 4) Verify on-chain receipts
  const approveTx = data["approve_tx"] as string | null;
  const swapTx = data["swap_tx"] as string;
  const transferTx = data["transfer_tx"] as string;
  const outputAmount = BigInt(data["output_amount"] as string);

  for (const [label, hash] of [
    ["approve", approveTx],
    ["swap   ", swapTx],
    ["transfer", transferTx],
  ] as Array<[string, string | null]>) {
    if (!hash) {
      console.log(`  ${label}: (skipped)`);
      continue;
    }
    const r = await txReceipt(hash);
    const ok = r && r.status === "0x1";
    console.log(
      `  ${label}: ${hash} ${ok ? "✓" : "✗ status=" + (r?.status ?? "missing")}`,
    );
  }
  console.log("");

  // 5) Snapshot balances AFTER and diff
  const afterBuyerUsdc = await erc20Balance(USDC, BUYER);
  const afterBuyerWeth = await erc20Balance(WETH, BUYER);
  const afterSwapUsdc = await erc20Balance(USDC, SWAP_WALLET);
  const afterSwapWeth = await erc20Balance(WETH, SWAP_WALLET);

  const buyerUsdcDelta = afterBuyerUsdc - beforeBuyerUsdc;
  const buyerWethDelta = afterBuyerWeth - beforeBuyerWeth;
  const swapUsdcDelta = afterSwapUsdc - beforeSwapUsdc;
  const swapWethDelta = afterSwapWeth - beforeSwapWeth;

  console.log("After:");
  console.log(`  buyer USDC: ${afterBuyerUsdc}  (Δ ${buyerUsdcDelta})`);
  console.log(`  buyer WETH: ${afterBuyerWeth}  (Δ ${buyerWethDelta})`);
  console.log(`  swap  USDC: ${afterSwapUsdc}  (Δ ${swapUsdcDelta})`);
  console.log(`  swap  WETH: ${afterSwapWeth}  (Δ ${swapWethDelta})\n`);

  // 6) BaseScan links
  console.log("BaseScan:");
  if (approveTx) console.log(`  approve : https://basescan.org/tx/${approveTx}`);
  console.log(`  swap    : https://basescan.org/tx/${swapTx}`);
  console.log(`  transfer: https://basescan.org/tx/${transferTx}`);
  if (paid.payment?.txHash) {
    console.log(`  x402 pay: https://basescan.org/tx/${paid.payment.txHash}`);
  }
  console.log("");

  const expectedTotal = BigInt(quote.total_cost);
  const buyerUsdcOk = buyerUsdcDelta === -expectedTotal;
  const buyerWethOk = buyerWethDelta === outputAmount;
  console.log(
    `Assertion: buyer USDC Δ == -${expectedTotal} → ${buyerUsdcOk ? "✓" : "✗"}`,
  );
  console.log(
    `Assertion: buyer WETH Δ == +${outputAmount} → ${buyerWethOk ? "✓" : "✗"}`,
  );
  process.exit(buyerUsdcOk && buyerWethOk ? 0 : 1);
}

main().catch((err) => {
  console.error("✗ smoke failed:", err);
  process.exit(1);
});
