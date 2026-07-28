#!/usr/bin/env tsx
/**
 * One-shot reconciliation for orphaned WETH from qb_f8f6d5a288124b99bba88d83dc567f71.
 *
 * The Sushi swap landed 548945379898203 WETH in the swap wallet but
 * mainnet.base.org returned stale state on the post-swap balance read,
 * so the executor recorded failed_slippage and never forwarded. Now
 * the WETH lives in 0x4261701A...453B2E with the buyer expecting it.
 *
 * This script:
 *   1. Reads current swap-wallet WETH balance (sanity check)
 *   2. Transfers it ALL to the buyer (0x3869dE...)
 *   3. Marks swap_refunds row 6b8b3243-... as 'voided' with reason
 *      manually-fulfilled-after-rpc-race + the new tx hash.
 *
 * Code fix landed in commit 83c5ca3 — this unwinds the in-flight
 * state. Not committed to git (one-shot).
 */

import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const SWAP_KEY_PATH = "/etc/suverse-pay/swap-base.key";
const SWAP_WALLET = "0x4261701A4dDf4625EBfA80CEefB5B3B2b5453B2E" as const;
const BUYER = "0x3869dE7597bDEa0172B97143f3eed806D8b84bf3" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;
const REFUND_ID = "6b8b3243-3934-4ce9-944e-cc4a68384df7";
const EXPECTED_AMOUNT = 548_945_379_898_203n;

const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const RPC = "https://mainnet.base.org";

async function main() {
  const raw = readFileSync(SWAP_KEY_PATH, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error("bad key shape");
  const account = privateKeyToAccount(raw as `0x${string}`);
  if (account.address.toLowerCase() !== SWAP_WALLET.toLowerCase()) {
    throw new Error(
      `derived ${account.address} != expected ${SWAP_WALLET}`,
    );
  }
  console.log(`▶ swap wallet:    ${SWAP_WALLET}`);
  console.log(`▶ buyer:          ${BUYER}`);
  console.log(`▶ asset:          WETH (${WETH})`);

  const publicClient = createPublicClient({ chain: base, transport: http(RPC) });
  const walletClient = createWalletClient({
    chain: base,
    account,
    transport: http(RPC),
  });

  const bal = (await publicClient.readContract({
    address: WETH,
    abi: ERC20_TRANSFER_ABI,
    functionName: "balanceOf",
    args: [SWAP_WALLET],
  })) as bigint;
  console.log(`▶ on-chain bal:   ${bal} atomic (expected ${EXPECTED_AMOUNT})`);
  if (bal !== EXPECTED_AMOUNT) {
    throw new Error(
      `balance ${bal} does not match expected orphan amount ${EXPECTED_AMOUNT} — aborting`,
    );
  }

  console.log(`\n▶ transferring ${bal} WETH → ${BUYER} …`);
  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [BUYER, bal],
  });
  const txHash = await walletClient.sendTransaction({
    account,
    chain: base,
    to: WETH,
    data,
    value: 0n,
  });
  console.log(`▶ tx submitted:   ${txHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 60_000,
  });
  console.log(
    `▶ receipt:        block=${receipt.blockNumber}  status=${receipt.status}  gasUsed=${receipt.gasUsed}`,
  );
  if (receipt.status !== "success") {
    throw new Error(`transfer reverted: ${txHash}`);
  }

  const afterBal = (await publicClient.readContract({
    address: WETH,
    abi: ERC20_TRANSFER_ABI,
    functionName: "balanceOf",
    args: [SWAP_WALLET],
  })) as bigint;
  console.log(`▶ swap WETH after: ${afterBal} (should be 0)`);

  const buyerBalAfter = (await publicClient.readContract({
    address: WETH,
    abi: ERC20_TRANSFER_ABI,
    functionName: "balanceOf",
    args: [BUYER],
  })) as bigint;
  console.log(`▶ buyer WETH after: ${buyerBalAfter}`);

  // Mark the refund row voided so accounting reflects the manual delivery.
  // Done via psql in a follow-up Bash step (pg isn't resolvable from this dir).
  console.log(`\n▶ next: mark refund row voided`);
  console.log(`  REFUND_ID=${REFUND_ID}`);
  console.log(`  delivery_tx=${txHash}`);
  console.log(`\nBaseScan: https://basescan.org/tx/${txHash}`);
  console.log("✓ on-chain reconcile complete");
}

main().catch((e) => {
  console.error("✗ reconcile failed:", e);
  process.exit(1);
});
