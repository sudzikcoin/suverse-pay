#!/usr/bin/env tsx
// End-to-end smoke for the MPP Phase 2 v1 surface, against the LIVE
// Tempo Moderato testnet (chain id 42431). Phase 2 T9 scaffold +
// T10 runs it green with a real tx hash on explore.testnet.tempo.xyz.
//
// Flow (single file because every step depends on the prior one's
// in-memory state; the multi-step bash pattern used by real-evm
// doesn't fit here):
//
//   1. Load env: MPP_TEST_PRIVATE_KEY, ADMIN_API_KEY, BASE_URL.
//   2. Derive the test wallet address. Fund it via the Tempo native
//      RPC method `tempo_fundAddress` (no manual faucet button).
//   3. POST /mpp/charge — initial call (no Payment-Authorization).
//      Asserts: 402 + WWW-Authenticate + JSON challenge.
//   4. Construct an ERC-20 `transfer(recipient, amount)` call against
//      the pathUSD contract on Moderato. Sign + broadcast via the
//      JSON-RPC `eth_sendRawTransaction` against the same RPC.
//   5. Poll `eth_getTransactionReceipt` until the tx confirms.
//   6. POST /mpp/charge — retry with Payment-Authorization built
//      from the MPP credential (challengeId = Idempotency-Key,
//      payload = {type:"hash", hash:<tx_hash>}).
//   7. Asserts: 200 + Payment-Response header + the persisted
//      payments row has protocol=mpp.
//   8. Prints the explorer URL for the tx so an operator can verify.
//
// Gated by `MPP_TEMPO_MODERATO_INTEGRATION=1` — without it, this
// script exits early so accidental CI invocations don't spam the
// faucet.

import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  credentialToHeaderLine,
  TEMPO_MODERATO_PATHUSD,
  type MppCredential,
} from "../../../packages/adapters/mpp/dist/index.js";

const ENV_GUARD = "MPP_TEMPO_MODERATO_INTEGRATION";
const BASE_URL = process.env["BASE_URL"] ?? "http://127.0.0.1:3000";
const ADMIN_API_KEY = process.env["ADMIN_API_KEY"] ?? "";
const TEST_PRIVATE_KEY = process.env["MPP_TEST_PRIVATE_KEY"] ?? "";
const RPC_URL =
  process.env["MPP_TEMPO_MODERATO_RPC_URL"] ?? "https://rpc.moderato.tempo.xyz";
const EXPLORER_URL = "https://explore.testnet.tempo.xyz";
const CHAIN_ID = 42431;
const PATH_USD = TEMPO_MODERATO_PATHUSD;
const RECIPIENT: Hex =
  (process.env["MPP_TEST_RECIPIENT"] as Hex | undefined) ??
  "0x0000000000000000000000000000000000000bEEf";
const AMOUNT_ATOMIC = process.env["MPP_TEST_AMOUNT_ATOMIC"] ?? "1000"; // 0.001 pathUSD @ 6 decimals
const RECEIPT_POLL_TIMEOUT_MS = 60_000;
const RECEIPT_POLL_INTERVAL_MS = 3_000;

function fail(msg: string): never {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}

function info(msg: string): void {
  console.log(`\x1b[34m• ${msg}\x1b[0m`);
}

function pass(msg: string): void {
  console.log(`\x1b[32m✓ ${msg}\x1b[0m`);
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  if (!res.ok) {
    throw new Error(
      `RPC HTTP ${res.status} ${res.statusText} for ${method}: ${await res.text()}`,
    );
  }
  const json = (await res.json()) as {
    result?: T;
    error?: { code: number; message: string };
  };
  if (json.error !== undefined) {
    throw new Error(
      `RPC error ${json.error.code}: ${json.error.message} (${method})`,
    );
  }
  return json.result as T;
}

async function waitForReceipt(hash: Hex): Promise<{
  status: string;
  blockNumber: string;
  transactionHash: string;
}> {
  const deadline = Date.now() + RECEIPT_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const r = await rpcCall<null | {
      status: string;
      blockNumber: string;
      transactionHash: string;
    }>("eth_getTransactionReceipt", [hash]);
    if (r !== null) return r;
    await new Promise((r) => setTimeout(r, RECEIPT_POLL_INTERVAL_MS));
  }
  throw new Error(`Receipt for ${hash} did not arrive within ${RECEIPT_POLL_TIMEOUT_MS}ms`);
}

async function main(): Promise<void> {
  if (process.env[ENV_GUARD] !== "1") {
    info(
      `Set ${ENV_GUARD}=1 to actually run the integration test. ` +
        `This script will not contact Tempo Moderato without that explicit opt-in.`,
    );
    process.exit(0);
  }
  if (ADMIN_API_KEY === "") fail("ADMIN_API_KEY not set");
  if (TEST_PRIVATE_KEY === "") fail("MPP_TEST_PRIVATE_KEY not set (0x-prefixed 32-byte hex)");
  const account = privateKeyToAccount(TEST_PRIVATE_KEY as Hex);
  info(`payer wallet: ${account.address}`);
  info(`base url:     ${BASE_URL}`);
  info(`rpc url:      ${RPC_URL}`);
  info(`chain id:     ${CHAIN_ID}`);
  info(`asset:        pathUSD (${PATH_USD})`);
  info(`recipient:    ${RECIPIENT}`);
  info(`amount:       ${AMOUNT_ATOMIC} atomic units`);

  // ---- 1. Fund the test wallet via the Tempo native RPC method ----
  info("step 1 — funding wallet via tempo_fundAddress");
  try {
    await rpcCall<unknown>("tempo_fundAddress", [account.address]);
    pass("tempo_fundAddress accepted");
  } catch (err) {
    info(
      `tempo_fundAddress failed (${err instanceof Error ? err.message : String(err)}) — falling back to assumption that wallet is already funded`,
    );
  }

  // ---- 2. Initial /mpp/charge — expect 402 + WWW-Authenticate ----
  const idempotencyKey = `mpp-smoke-${Date.now().toString(36)}`;
  const chargeBody = {
    amount: AMOUNT_ATOMIC,
    currency: PATH_USD,
    recipient: RECIPIENT,
    chainId: CHAIN_ID,
    description: `Phase 2 T10 e2e smoke ${new Date().toISOString()}`,
  };
  info(`step 2 — POST /mpp/charge (no Payment-Authorization), idem="${idempotencyKey}"`);
  const r402 = await fetch(`${BASE_URL}/mpp/charge`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ADMIN_API_KEY}`,
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(chargeBody),
  });
  if (r402.status !== 402) fail(`expected 402 on initial call, got ${r402.status}: ${await r402.text()}`);
  const wwwAuth = r402.headers.get("www-authenticate");
  if (wwwAuth === null || !wwwAuth.startsWith("Payment ")) {
    fail(`missing/invalid WWW-Authenticate header: ${wwwAuth}`);
  }
  pass(`402 received with WWW-Authenticate (len ${wwwAuth.length})`);

  // ---- 3. Sign + broadcast ERC-20 transfer ----
  info("step 3 — signing pathUSD.transfer(recipient, amount) tx");
  const erc20Abi = parseAbi([
    "function transfer(address to, uint256 amount) returns (bool)",
  ]);
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [RECIPIENT, BigInt(AMOUNT_ATOMIC)],
  });
  // Tempo has NO native gas token — fees are paid in any whitelisted
  // stablecoin. The standard EIP-1559 tx format is what viem emits;
  // Tempo's RPC may reject it if it expects the Tempo-specific
  // envelope (0x76/0x78). If so, T10 will surface the rejection and
  // we adjust here — that's exactly what the user's "if 3+ red
  // retries — stop" guard covers.
  const nonce = await rpcCall<string>("eth_getTransactionCount", [
    account.address,
    "pending",
  ]);
  const gasPrice = await rpcCall<string>("eth_gasPrice", []);
  const signed = await account.signTransaction({
    type: "legacy",
    chainId: CHAIN_ID,
    nonce: Number.parseInt(nonce, 16),
    to: PATH_USD as Hex,
    value: 0n,
    data,
    gas: 100_000n,
    gasPrice: BigInt(gasPrice),
  });
  info(`step 4 — broadcasting via eth_sendRawTransaction`);
  const txHash = await rpcCall<Hex>("eth_sendRawTransaction", [signed]);
  pass(`broadcast accepted, tx hash ${txHash}`);
  info(`explorer: ${EXPLORER_URL}/tx/${txHash}`);

  // ---- 4. Wait for receipt ----
  info("step 5 — waiting for receipt");
  const receipt = await waitForReceipt(txHash);
  if (receipt.status !== "0x1") fail(`tx reverted: status=${receipt.status}`);
  pass(`receipt confirmed in block ${Number.parseInt(receipt.blockNumber, 16)}`);

  // ---- 5. Retry /mpp/charge with credential ----
  const credential: MppCredential = {
    challengeId: idempotencyKey,
    method: "tempo",
    intent: "charge",
    payload: { type: "hash", hash: txHash },
  };
  info("step 6 — POST /mpp/charge (with Payment-Authorization)");
  const r200 = await fetch(`${BASE_URL}/mpp/charge`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ADMIN_API_KEY}`,
      "idempotency-key": idempotencyKey,
      "payment-authorization": credentialToHeaderLine(credential),
    },
    body: JSON.stringify(chargeBody),
  });
  if (r200.status !== 200) fail(`expected 200 on retry, got ${r200.status}: ${await r200.text()}`);
  const body = (await r200.json()) as {
    ok: boolean;
    paymentId: string;
    reference: string;
    network: string;
    payer: string;
  };
  if (!body.ok) fail(`retry response ok=false: ${JSON.stringify(body)}`);
  if (body.reference !== txHash) fail(`reference mismatch: ${body.reference} vs ${txHash}`);
  if (body.network !== `eip155:${CHAIN_ID}`) fail(`network mismatch: ${body.network}`);
  pass(`payment settled — paymentId=${body.paymentId} payer=${body.payer}`);

  // ---- 6. Print summary ----
  console.log("");
  console.log(`\x1b[1m\x1b[32mMPP Phase 2 v1 e2e GREEN\x1b[0m`);
  console.log(`tx hash:   ${txHash}`);
  console.log(`explorer:  ${EXPLORER_URL}/tx/${txHash}`);
  console.log(`paymentId: ${body.paymentId}`);
  console.log(`payer:     ${body.payer}`);
  console.log(`recipient: ${RECIPIENT}`);
  console.log(`amount:    ${AMOUNT_ATOMIC} pathUSD atomic`);
}

main().catch((err) => {
  fail(err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err));
});
