#!/usr/bin/env node
/**
 * sweep-payto.mjs — gasless auto-sweep of payTo merchant wallets to the
 * operator's main wallet, using USDC EIP-3009 transferWithAuthorization.
 *
 * WHY GASLESS: payTo wallets only RECEIVE x402 settlements; they hold no
 * ETH and we never want them to. Each payTo SIGNS an EIP-3009 transfer
 * authorization off-chain (no gas), and a single funded RELAYER wallet
 * broadcasts it and pays the (tiny, Base) gas. transferWithAuthorization
 * sends to a FIXED destination (the main wallet), so even if the signed
 * auth were front-run, it can only move our funds to our own wallet.
 *
 * SOURCES   : every pool wallet (payto-pool.json) that has an on-disk key
 *             AND is not the main wallet. Key->address is verified before
 *             signing (refuses to sign with a mismatched key).
 * DEST      : MAIN_WALLET (operator's wallet; the one the user controls).
 * RELAYER   : base-payer.key (already funded with ETH). Never swept.
 * THRESHOLD : sweep a wallet only when its USDC >= --threshold (default
 *             $1.00). payTo wallets do NOT fund settles (the relayer does),
 *             so the FULL balance is swept — no reserve left behind.
 * RESERVE   : the only wallet that needs gas is the RELAYER; the job aborts
 *             (loudly) if the relayer's ETH is below --min-relayer-eth so it
 *             is never left unable to broadcast.
 *
 * IDEMPOTENT (three independent guards):
 *   1. flock lockfile  -> no two instances run at once.
 *   2. balance recheck -> an already-drained wallet (< threshold) is skipped.
 *   3. inflight state  -> a wallet with an unconfirmed sweep tx is skipped
 *                         until that tx confirms; the EIP-3009 `nonce` is
 *                         also checked on-chain (authorizationState) so the
 *                         same authorization can never settle twice.
 *
 * LOGS every sweep (from,to,amount,nonce,txHash,status) as JSON lines to
 *   /var/log/suverse-pay/sweep.log  (+ a rolling state file alongside).
 *
 * Usage:
 *   node sweep-payto.mjs --dry-run                 # sign but DON'T broadcast
 *   node sweep-payto.mjs --dry-run --threshold 50000   # demo at $0.05
 *   node sweep-payto.mjs                           # LIVE
 * Env: SWEEP_MAIN_WALLET (override dest), RELAYER_KEY_PATH (override relayer).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import {
  createPublicClient, createWalletClient, http, getAddress,
  formatUnits, keccak256, encodePacked, toHex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// ---- config ---------------------------------------------------------------
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // native USDC on Base
const RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const POOL = "/etc/suverse-pay/payto-pool.json";
const MAIN_WALLET = getAddress(
  process.env.SWEEP_MAIN_WALLET ?? "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0",
);
const RELAYER_KEY_PATH = process.env.RELAYER_KEY_PATH ?? "/etc/suverse-pay/base-payer.key";
const LOG = "/var/log/suverse-pay/sweep.log";
const STATE = "/var/log/suverse-pay/sweep-state.json";
const LOCK = "/tmp/suverse-pay-sweep.lock";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const DRY = !!arg("dry-run", false);
const THRESHOLD = BigInt(arg("threshold", "1000000")); // atomic USDC ($1.00)
const MIN_RELAYER_ETH = BigInt(arg("min-relayer-eth", "30000000000000")); // 0.00003 ETH

const usdcAbi = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "version", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "authorizationState", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }, { name: "n", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { name: "transferWithAuthorization", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" },
    ], outputs: [] },
];

const pub = createPublicClient({ chain: base, transport: http(RPC) });
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Public Base RPC rate-limits bursts; retry reads with backoff so a single
// sweep run never aborts mid-wallet on a transient "over rate limit".
async function withRetry(fn, label, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; await sleep(600 * (i + 1)); }
  }
  throw new Error(`${label}: ${String(last?.shortMessage ?? last?.message ?? last)}`);
}
const readUsdc = (fn, args) => withRetry(
  () => pub.readContract({ address: USDC, abi: usdcAbi, functionName: fn, args }), `read:${fn}`);
const log = (o) => {
  mkdirSync(dirname(LOG), { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...o });
  console.log(line);
  try { writeFileSync(LOG, line + "\n", { flag: "a" }); } catch {}
};
const loadState = () => { try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return {}; } };
const saveState = (s) => { try { mkdirSync(dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 2)); } catch {} };

async function main() {
  // ---- single-instance lock (guard #1) -----------------------------------
  let lockFd;
  try { lockFd = openSync(LOCK, "wx"); }
  catch { log({ event: "skip", reason: "another sweep instance holds the lock" }); return; }
  try {
    const state = loadState();

    // ---- relayer + gas reserve (never leave it unable to broadcast) ------
    const relayerKey = readFileSync(RELAYER_KEY_PATH, "utf8").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(relayerKey)) throw new Error("relayer key invalid");
    const relayer = privateKeyToAccount(relayerKey);
    const relayerEth = await withRetry(() => pub.getBalance({ address: relayer.address }), "getBalance:relayer");
    if (relayerEth < MIN_RELAYER_ETH) {
      log({ event: "abort", reason: "relayer ETH below reserve", relayer: relayer.address,
            eth: formatUnits(relayerEth, 18), need: formatUnits(MIN_RELAYER_ETH, 18) });
      return;
    }
    const wallet = createWalletClient({ account: relayer, chain: base, transport: http(RPC) });

    // ---- EIP-712 domain (read from contract so sig can't mismatch) -------
    const [tokenName, tokenVersion] = await Promise.all([
      readUsdc("name", []).catch(() => "USD Coin"),
      readUsdc("version", []).catch(() => "2"),
    ]);
    const domain = { name: tokenName, version: tokenVersion, chainId: 8453, verifyingContract: USDC };
    const types = { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ] };

    // ---- sources -----------------------------------------------------------
    const pool = JSON.parse(readFileSync(POOL, "utf8"));
    const sources = pool.wallets.filter(
      (w) => w.keyPath && existsSync(w.keyPath) && getAddress(w.address) !== MAIN_WALLET,
    );
    log({ event: "start", dryRun: DRY, dest: MAIN_WALLET, relayer: relayer.address,
          relayerEth: formatUnits(relayerEth, 18), thresholdUsdc: formatUnits(THRESHOLD, 6), sources: sources.length });

    let swept = 0;
    for (const w of sources) {
      const from = getAddress(w.address);
      await sleep(400); // pace the public RPC
      const bal = await readUsdc("balanceOf", [from]);

      // guard #2: don't sweep below threshold (also makes an empty wallet a no-op)
      if (bal < THRESHOLD) { log({ event: "skip", from, reason: "below_threshold", usdc: formatUnits(bal, 6) }); continue; }

      // guard #3: skip a wallet whose previous sweep tx is not yet confirmed
      const pend = state[from]?.inflight;
      if (pend?.txHash) {
        const rcpt = await pub.getTransactionReceipt({ hash: pend.txHash }).catch(() => null);
        if (!rcpt) { log({ event: "skip", from, reason: "inflight_unconfirmed", txHash: pend.txHash }); continue; }
        delete state[from].inflight; saveState(state); // confirmed -> clear, re-evaluate below
      }

      // verify the on-disk key actually controls this address before signing
      const k = readFileSync(w.keyPath, "utf8").trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(k)) { log({ event: "error", from, reason: "key_invalid_format", keyPath: w.keyPath }); continue; }
      const acct = privateKeyToAccount(k);
      if (getAddress(acct.address) !== from) { log({ event: "error", from, reason: "key_address_mismatch", derived: acct.address }); continue; }

      const value = bal; // full balance; payTo wallets never need a reserve
      const validAfter = 0n;
      const validBefore = BigInt(now() + 3600);
      // deterministic-ish nonce bound to (from,value,hour) so an accidental
      // re-sign of the same balance reuses the nonce -> on-chain replay-revert.
      const nonce = keccak256(encodePacked(
        ["address", "uint256", "uint256"], [from, value, BigInt(Math.floor(now() / 3600))],
      ));
      const used = await readUsdc("authorizationState", [from, nonce]);
      if (used) { log({ event: "skip", from, reason: "nonce_already_used_onchain", nonce }); continue; }

      const sig = await acct.signTypedData({ domain, types, primaryType: "TransferWithAuthorization",
        message: { from, to: MAIN_WALLET, value, validAfter, validBefore, nonce } });
      const r = "0x" + sig.slice(2, 66), s = "0x" + sig.slice(66, 130);
      const v = parseInt(sig.slice(130, 132), 16);

      if (DRY) {
        log({ event: "dry_run_would_sweep", from, to: MAIN_WALLET, usdc: formatUnits(value, 6),
              nonce, signed: true, v });
        swept++;
        continue;
      }

      // LIVE: relayer broadcasts; record inflight BEFORE sending (crash-safe)
      state[from] = { ...(state[from] || {}), inflight: { nonce, value: value.toString(), startedAt: new Date().toISOString() } };
      saveState(state);
      const txHash = await wallet.writeContract({ address: USDC, abi: usdcAbi, functionName: "transferWithAuthorization",
        args: [from, MAIN_WALLET, value, validAfter, validBefore, nonce, v, r, s] });
      const rcpt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 120000 });
      state[from].inflight = { ...state[from].inflight, txHash };
      if (rcpt.status === "success") {
        delete state[from].inflight;
        state[from].lastSweep = { to: MAIN_WALLET, usdc: formatUnits(value, 6), nonce, txHash, at: new Date().toISOString() };
        saveState(state);
        log({ event: "swept", from, to: MAIN_WALLET, usdc: formatUnits(value, 6), nonce, txHash, status: "success" });
        swept++;
      } else {
        saveState(state); // keep inflight for inspection
        log({ event: "swept_reverted", from, to: MAIN_WALLET, usdc: formatUnits(value, 6), nonce, txHash, status: "reverted" });
      }
    }
    log({ event: "done", dryRun: DRY, sweptOrWould: swept });
  } finally {
    try { closeSync(lockFd); } catch {}
    try { (await import("node:fs")).unlinkSync(LOCK); } catch {}
  }
}
main().catch((e) => { log({ event: "fatal", error: String(e?.message ?? e) }); process.exitCode = 1; });
