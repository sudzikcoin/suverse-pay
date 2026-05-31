#!/usr/bin/env tsx
/**
 * Real SKALE Base Sepolia smoke — direct against PayAI.
 *
 * Signs an EIP-3009 `transferWithAuthorization` payload for the SKALE
 * Bridge-issued USDC.e on SKALE Base Sepolia (chainId 324705682), then
 * exercises PayAI's `/verify` and `/settle` endpoints directly — no
 * suverse-pay gateway in the loop. Once verify + settle pass with a
 * real tx hash visible on the SKALE Base Sepolia explorer, the gateway
 * integration follows trivially because routing-config.ts already
 * points eip155:324705682:exact at PayAI.
 *
 * What you need
 * -------------
 *  - `.env.evm-sepolia` at the repo root (same file the real-evm smoke
 *    reuses):
 *
 *        EVM_TESTNET_MNEMONIC="<12 words>"
 *        EVM_TESTNET_ADDRESS=0x...
 *
 *  - The test address funded with **USDC.e on SKALE Base Sepolia**.
 *    Bridge a small amount from Base Sepolia USDC
 *    (0x036CbD53842c5426634e7929541eC2318f3dCF7e) into SKALE Base
 *    Sepolia (0x2e08028E3C4c2356572E096d8EF835cD5C6030bD) via
 *    https://base-sepolia.skalenodes.com/chains/base. The wallet needs
 *    no native gas — SKALE Base is gasless for buyers (PayAI as
 *    relayer pre-pays CREDIT).
 *
 *  - `pnpm --filter @suverse-pay/signer-evm build` must have run at
 *    least once so the imported dist/ is up to date.
 *
 *  - Optional `PAYAI_API_KEY_ID` + `PAYAI_API_KEY_SECRET` in the env.
 *    If absent, the request goes unauthenticated; PayAI accepts either.
 *
 * What it asserts
 * ---------------
 *  - PayAI `/verify` returns `isValid: true` for the EIP-3009 payload
 *    on SKALE Base Sepolia.
 *  - PayAI `/settle` returns `success: true` with a 32-byte hex tx
 *    hash.
 *  - Prints the explorer URL so the operator can visually confirm
 *    inclusion on https://skale-base-sepolia-explorer.skalenodes.com.
 *
 * What it does NOT do
 * -------------------
 *  - It does not poll the explorer for tx receipt — SKALE blocks fast
 *    enough that the settle response carries a tx hash, but block
 *    inclusion verification is left to the operator (open the
 *    explorer URL).
 *  - It does not exercise the suverse-pay gateway. That's a deliberate
 *    isolation: this smoke answers "does PayAI accept our signature?"
 *    If yes, the gateway integration is just S3's routing-config row.
 *
 * Usage
 * -----
 *      pnpm --filter @suverse-pay/signer-evm build
 *      pnpm tsx scripts/smoke/real-skale-base/smoke.mts \
 *        --pay-to 0xYourReceivingAddress \
 *        [--amount 1000] \
 *        [--payai https://facilitator.payai.network]
 *
 * The default amount is 1000 atomic = 0.001 USDC.e per run.
 */

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { signPaymentPayload } from "../../../packages/signers/evm/dist/index.js";

interface CliArgs {
  payTo: `0x${string}`;
  amount: string;
  payAi: string;
  network: string;
  asset: `0x${string}`;
}

const SKALE_BASE_SEPOLIA_NETWORK = "eip155:324705682";
const SKALE_BASE_SEPOLIA_USDC_E = "0x2e08028E3C4c2356572E096d8EF835cD5C6030bD";
const PAYAI_DEFAULT = "https://facilitator.payai.network";
const EXPLORER_BASE = "https://skale-base-sepolia-explorer.skalenodes.com";

function parseArgs(argv: readonly string[]): CliArgs {
  const out: Partial<CliArgs> = {
    network: SKALE_BASE_SEPOLIA_NETWORK,
    asset: SKALE_BASE_SEPOLIA_USDC_E,
    amount: "1000",
    payAi: process.env.SMOKE_PAYAI_URL ?? PAYAI_DEFAULT,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--pay-to":  out.payTo = value as `0x${string}`; i++; break;
      case "--amount":  out.amount = value!; i++; break;
      case "--payai":   out.payAi = value!; i++; break;
      case "--network": out.network = value!; i++; break;
      case "--asset":   out.asset = value as `0x${string}`; i++; break;
    }
  }
  if (!out.payTo) {
    throw new Error("missing required flag --pay-to 0x...");
  }
  return out as CliArgs;
}

function loadEnv(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2]!;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[match[1]!] = value;
  }
  return result;
}

function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}
function green(s: string): string {
  return `\x1b[32m${s}\x1b[0m`;
}
function red(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}
function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

async function postJson(
  url: string,
  body: unknown,
  authHeader: string | null,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (authHeader) headers.Authorization = authHeader;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let parsed: unknown = null;
  const text = await res.text();
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv("/home/govhub/suverse-pay/.env.evm-sepolia");
  const mnemonic = env.EVM_TESTNET_MNEMONIC;
  const fromAddress = env.EVM_TESTNET_ADDRESS;
  if (!mnemonic) {
    throw new Error(".env.evm-sepolia missing EVM_TESTNET_MNEMONIC");
  }
  if (!fromAddress) {
    throw new Error(".env.evm-sepolia missing EVM_TESTNET_ADDRESS");
  }

  console.log(bold("━━━ SKALE Base Sepolia · PayAI · real settle ━━━"));
  console.log(`  network:  ${args.network}`);
  console.log(`  USDC.e:   ${args.asset}`);
  console.log(`  from:     ${fromAddress}`);
  console.log(`  to:       ${args.payTo}`);
  console.log(`  amount:   ${args.amount} atomic (≈ $${(Number(args.amount) / 1_000_000).toFixed(6)})`);
  console.log(`  PayAI:    ${args.payAi}`);
  console.log("");

  // Build paymentRequirements + sign. The EIP-712 domain comes from
  // signer-evm's trusted table — see domains.ts entry for chainId
  // 324705682 ("Bridged USDC (SKALE Bridge)" / "2").
  const requirements = {
    scheme: "exact",
    network: args.network,
    maxAmountRequired: args.amount,
    asset: args.asset,
    payTo: args.payTo,
    resource: "https://suverse-pay.example/v1/smoke/real-skale-base",
    description: "real-skale-base smoke — SKALE Base Sepolia USDC.e via PayAI",
    mimeType: "application/json",
    maxTimeoutSeconds: 60,
    extra: {
      // On-chain-verified strings — DO NOT edit without re-running
      // `eth_call name()` / `version()` against the deployed contract.
      name: "Bridged USDC (SKALE Bridge)",
      version: "2",
      decimals: 6,
      symbol: "USDC.e",
    },
  } as const;

  console.log(dim("  signing EIP-3009 transferWithAuthorization..."));
  const signed = await signPaymentPayload({
    secret: mnemonic,
    network: args.network,
    requirements,
    amount: args.amount,
    validitySeconds: 60,
  });
  const nonce = signed.paymentPayload.payload.authorization.nonce;
  console.log(`  ${green("✓")} signed; nonce=${nonce}`);
  console.log("");

  // PayAI auth — Basic if credentials present, otherwise anonymous.
  let authHeader: string | null = null;
  if (env.PAYAI_API_KEY_ID && env.PAYAI_API_KEY_SECRET) {
    const credentials = `${env.PAYAI_API_KEY_ID}:${env.PAYAI_API_KEY_SECRET}`;
    authHeader = `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
    console.log(dim("  using PayAI Basic auth from env"));
  } else {
    console.log(dim("  no PAYAI_API_KEY_* env — sending unauthenticated"));
  }

  const facilitatorBody = {
    x402Version: 2,
    paymentPayload: signed.paymentPayload,
    paymentRequirements: signed.paymentRequirements,
  };

  // ---- /verify ------------------------------------------------------
  console.log(bold("\n━━━ /verify ━━━"));
  const verify = await postJson(
    `${args.payAi.replace(/\/+$/, "")}/verify`,
    facilitatorBody,
    authHeader,
  );
  console.log(`  HTTP ${verify.status}`);
  console.log(`  body: ${JSON.stringify(verify.body, null, 2)}`);
  const verifyObj =
    verify.body && typeof verify.body === "object"
      ? (verify.body as Record<string, unknown>)
      : {};
  if (verify.status !== 200 || verifyObj.isValid !== true) {
    console.log(
      red(
        `\n  ✘ verify failed — invalidReason=${String(verifyObj.invalidReason ?? "?")}`,
      ),
    );
    console.log(
      red(
        "\n    STOP. Do not proceed to /settle. Capture the body above and",
      ),
    );
    console.log(
      red(
        "    report — usually a domain-name mismatch (PayAI expects something",
      ),
    );
    console.log(
      red(
        "    other than 'Bridged USDC (SKALE Bridge)' / version '2') or an asset-",
      ),
    );
    console.log(
      red(
        "    address mismatch. Re-run eth_call before editing domains.ts.",
      ),
    );
    process.exit(2);
  }
  console.log(green("  ✓ verify isValid=true"));

  // ---- /settle ------------------------------------------------------
  const idem = `skale-smoke-${Date.now()}-${randomBytes(3).toString("hex")}`;
  console.log(bold("\n━━━ /settle ━━━"));
  console.log(`  Idempotency-Key: ${idem}`);
  const settleHeaders: Record<string, string> = {};
  if (authHeader) settleHeaders.Authorization = authHeader;
  settleHeaders["Idempotency-Key"] = idem;
  const settleRes = await fetch(
    `${args.payAi.replace(/\/+$/, "")}/settle`,
    {
      method: "POST",
      headers: {
        ...settleHeaders,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(facilitatorBody),
    },
  );
  const settleText = await settleRes.text();
  let settleBody: unknown;
  try {
    settleBody = JSON.parse(settleText);
  } catch {
    settleBody = settleText;
  }
  console.log(`  HTTP ${settleRes.status}`);
  console.log(`  body: ${JSON.stringify(settleBody, null, 2)}`);

  const settleObj =
    settleBody && typeof settleBody === "object"
      ? (settleBody as Record<string, unknown>)
      : {};
  if (settleRes.status !== 200 || settleObj.success !== true) {
    console.log(
      red(
        `\n  ✘ settle failed — errorReason=${String(settleObj.errorReason ?? "?")}`,
      ),
    );
    process.exit(3);
  }

  const txHash =
    typeof settleObj.transaction === "string"
      ? (settleObj.transaction as string)
      : typeof settleObj.txHash === "string"
      ? (settleObj.txHash as string)
      : null;
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    console.log(red(`\n  ✘ settle returned no/invalid txHash: ${String(txHash)}`));
    process.exit(4);
  }

  console.log(green(`\n  ✓ settled — txHash=${txHash}`));
  console.log(bold("\n━━━ explorer ━━━"));
  console.log(`  ${EXPLORER_BASE}/tx/${txHash}`);
  console.log("");
  console.log(
    green("ALL CHECKS PASSED — open the explorer URL to visually confirm inclusion."),
  );
}

main().catch((err: unknown) => {
  console.error("smoke failed:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
