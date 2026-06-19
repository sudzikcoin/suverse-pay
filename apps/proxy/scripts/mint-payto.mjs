#!/usr/bin/env node
/**
 * mint-payto.mjs — generate a fresh service payTo wallet for CDP-Bazaar
 * payTo rotation. CDP appears to cap how many resources it will index
 * under a single payTo (observed ceiling ~93 on the original merchant
 * address: 38 confirmed on-chain settles past 93 produced zero new
 * merchant rows). To keep indexing past the cap we rotate payTo per
 * batch, each well under the ceiling.
 *
 * A payTo only RECEIVES USDC, so its private key is not needed to index
 * — but we persist it anyway (chmod 600) so funds are recoverable, per
 * the project key rule (never key-in-memory-only).
 *
 * Writes:
 *   /etc/suverse-pay/payto-<NNN>.key   (0x+64hex, mode 600)
 *   /etc/suverse-pay/payto-pool.json   (registry; sets the new one active)
 *
 * Usage: node apps/proxy/scripts/mint-payto.mjs [--cap 80] [--no-active]
 */
import { writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const POOL = "/etc/suverse-pay/payto-pool.json";
const cap = Number(process.argv.includes("--cap") ? process.argv[process.argv.indexOf("--cap") + 1] : 80);
const setActive = !process.argv.includes("--no-active");

const pool = existsSync(POOL)
  ? JSON.parse(readFileSync(POOL, "utf8"))
  : { cap, activePayTo: null, wallets: [] };
pool.cap = cap;

const n = pool.wallets.length + 1;
const keyPath = `/etc/suverse-pay/payto-${String(n).padStart(3, "0")}.key`;
const pk = generatePrivateKey();
const address = privateKeyToAccount(pk).address;

writeFileSync(keyPath, pk + "\n", { mode: 0o600 });
chmodSync(keyPath, 0o600);

pool.wallets.push({ address, keyPath, cap, mintedAt: process.env.MINT_DATE ?? null, note: "rotation payTo" });
if (setActive) pool.activePayTo = address;
writeFileSync(POOL, JSON.stringify(pool, null, 2) + "\n", { mode: 0o600 });
chmodSync(POOL, 0o600);

console.log(`minted payTo ${address}`);
console.log(`  key:  ${keyPath} (mode 600)`);
console.log(`  pool: ${POOL} (active=${pool.activePayTo})`);
console.log(address);
