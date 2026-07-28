#!/usr/bin/env tsx
/**
 * One-shot reconciliation for the orphaned WETH from the first Base
 * swap smoke test (quote_id qb_c60dca2c05ef484190afdd2b60f63afe).
 *
 * Root cause: load-balanced mainnet.base.org returned stale state on
 * the post-swap balance read, so the orchestrator saw 0 WETH delivered
 * (when ~0.000202 WETH had actually landed) and short-circuited to a
 * pending-refund instead of forwarding to the buyer.
 *
 * This script:
 *   1. Reads the swap wallet's current WETH balance
 *   2. Transfers ALL of it to the buyer (the intended recipient)
 *   3. Marks the swap_refunds row as 'voided' with reason
 *      'manually-fulfilled-after-rpc-race'
 *
 * Code fix is committed separately; this just unwinds the in-flight
 * state. Run once, then never again.
 */

import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const SWAP_KEY_PATH =
  process.env["SWAP_BASE_PRIVKEY_PATH"] ?? "/etc/suverse-pay/swap-base.key";
const BUYER = "0x3869dE7597bDEa0172B97143f3eed806D8b84bf3" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;
const REFUND_ID =
  process.env["REFUND_ID"] ?? "18b66248-3c0f-4a00-9ada-fcb1f0e29958";

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
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
] as const;

const raw = readFileSync(SWAP_KEY_PATH, "utf8").trim() as `0x${string}`;
const account = privateKeyToAccount(raw);
const publicClient = createPublicClient({
  chain: base,
  transport: http("https://mainnet.base.org"),
});
const walletClient = createWalletClient({
  chain: base,
  account,
  transport: http("https://mainnet.base.org"),
});

const balance = (await publicClient.readContract({
  address: WETH,
  abi: ERC20_ABI,
  functionName: "balanceOf",
  args: [account.address],
})) as bigint;
console.log(`swap wallet WETH balance: ${balance}`);

if (balance === 0n) {
  console.log("nothing to reconcile");
  process.exit(0);
}

const data = encodeFunctionData({
  abi: ERC20_ABI,
  functionName: "transfer",
  args: [BUYER, balance],
});

console.log(`▶ transferring ${balance} WETH atomic → ${BUYER}`);
const txHash = await walletClient.sendTransaction({
  account,
  chain: base,
  to: WETH,
  data,
  value: 0n,
});
console.log(`▶ tx: ${txHash}`);

const receipt = await publicClient.waitForTransactionReceipt({
  hash: txHash,
  timeout: 60_000,
});
console.log(`▶ confirmed in block ${receipt.blockNumber}, status=${receipt.status}`);

if (receipt.status !== "success") {
  console.error("✗ transfer reverted — refund row left as pending");
  process.exit(1);
}

console.log(`\n✓ transfer done — now run:`);
console.log(
  `  psql "$DATABASE_URL" -c "UPDATE swap_refunds SET status='voided', refund_tx_hash='${txHash}', refunded_at=NOW(), reason=reason || ' | resolved: manually-fulfilled-after-rpc-race ${txHash}' WHERE id='${REFUND_ID}';"`,
);
console.log(`  transfer tx: https://basescan.org/tx/${txHash}`);
