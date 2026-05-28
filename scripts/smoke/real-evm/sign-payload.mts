#!/usr/bin/env tsx
// Sign an EIP-3009 transferWithAuthorization PaymentPayload for Base
// Sepolia USDC using the test mnemonic from .env.evm-sepolia, then
// write the full `{paymentPayload, paymentRequirements}` envelope to
// the path given by `--out`.
//
// This is a thin CLI wrapper around the workspace EVM signer. Each
// invocation generates a fresh random 32-byte nonce (suitable for a
// single on-chain settle). The 05-settle-idempotent step reuses the
// fixture file written by 04-settle — it does NOT re-sign — so the
// same nonce flows through both calls and the gateway's idempotency
// path is exercised under real conditions.
import { readFileSync, writeFileSync } from "node:fs";
// This script lives at scripts/smoke/real-evm/ — outside any pnpm
// workspace package — so the workspace alias `@suverse-pay/signer-evm`
// is not resolvable from here. Point at the package's built dist by
// relative path; `pnpm build` is part of the suite's prerequisites.
import { signPaymentPayload } from "../../../packages/signers/evm/dist/index.js";

interface CliArgs {
  out: string;
  network: string;
  asset: `0x${string}`;
  payTo: `0x${string}`;
  amount: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--out": args.out = value; i++; break;
      case "--network": args.network = value; i++; break;
      case "--asset": args.asset = value as `0x${string}`; i++; break;
      case "--pay-to": args.payTo = value as `0x${string}`; i++; break;
      case "--amount": args.amount = value; i++; break;
    }
  }
  for (const k of ["out", "network", "asset", "payTo", "amount"] as const) {
    if (args[k] === undefined || args[k] === "") {
      throw new Error(`missing required flag --${k.replace(/([A-Z])/g, "-$1").toLowerCase()}`);
    }
  }
  return args as CliArgs;
}

// Minimal .env loader — KEY=VALUE only, strips matching outer quotes.
function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]!] = v;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv("/home/govhub/suverse-pay/.env.evm-sepolia");
  const mnemonic = env.EVM_TESTNET_MNEMONIC;
  if (!mnemonic) {
    throw new Error(".env.evm-sepolia missing EVM_TESTNET_MNEMONIC");
  }

  const requirements = {
    scheme: "exact",
    network: args.network,
    maxAmountRequired: args.amount,
    asset: args.asset,
    payTo: args.payTo,
    resource: "https://suverse-pay.example/v1/smoke/real-evm",
    description: "real-evm smoke — Base Sepolia USDC via Coinbase CDP",
    mimeType: "application/json",
    maxTimeoutSeconds: 60,
    extra: {
      // Base Sepolia USDC's on-chain EIP-712 domain (name() / version()
      // confirmed via eth_call at deploy time). Mainnet USDC uses
      // ("USD Coin", "2"); the test deployment uses ("USDC", "2"). The
      // signer defends against a malicious resource server by cross-
      // checking these against its local trusted table.
      name: "USDC",
      version: "2",
      decimals: 6,
      symbol: "USDC",
    },
  } as const;

  const signed = await signPaymentPayload({
    secret: mnemonic,
    network: args.network,
    requirements,
    amount: args.amount,
    validitySeconds: 60,
  });

  writeFileSync(args.out, JSON.stringify(signed, null, 2));
  // Emit the nonce on stdout — the calling shell uses it for logging.
  process.stdout.write(signed.paymentPayload.payload.authorization.nonce + "\n");
}

main().catch((err: unknown) => {
  console.error("sign-payload failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
