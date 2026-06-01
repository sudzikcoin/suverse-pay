#!/usr/bin/env tsx
/**
 * One-shot verify against the production solana-tx-decoder wrap.
 *
 * Spends $0.20 USDC on Base from PAYER_BASE_PRIVATE_KEY_PATH to
 * https://proxy.suverse.io/v1/data/solana-tx-decoder. After the call,
 * the operator inspects facilitator_payments for the new
 * pending → settled / upstream_failed transition introduced by
 * d113535.
 *
 * Run from /home/govhub/suverse-pay; reads PAYER_BASE_PRIVATE_KEY_PATH
 * (default /etc/suverse-pay/base-payer.key) and SMOKE_TX_DECODER_URL
 * (default the wrapped slug) from the env.
 */

import { readFileSync } from "node:fs";
// Resolve directly to the dist file to avoid pnpm workspace lookup
// (this script lives in scripts/dev/, outside any package).
import { SuverseClient } from "../../node_modules/.pnpm/@suverselabs+x402-client@0.1.0_typescript@5.9.3_zod@3.25.76/node_modules/@suverselabs/x402-client/dist/index.js";

const URL_TARGET =
  process.env["SMOKE_TX_DECODER_URL"] ??
  "https://proxy.suverse.io/v1/data/solana-tx-decoder";

const KEY_PATH =
  process.env["PAYER_BASE_PRIVATE_KEY_PATH"] ??
  "/etc/suverse-pay/base-payer.key";

const SAMPLE_SIGNATURE =
  process.env["SMOKE_TX_DECODER_SIGNATURE"] ??
  // A historical real Jupiter swap signature on Solana mainnet, used
  // purely so the decoder has SOMETHING to decode.
  "5KQwrPbwdL6PhXujxW37FSSbT5HG4d6V8c5jYrqWwG6QrBmbX2RhPZ8M9LrgDmBnYpZHVz9KvxWsyABcdEfGhij1";

function readHexKey(path: string): `0x${string}` {
  const raw = readFileSync(path, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`unexpected key shape in ${path}`);
  }
  return raw as `0x${string}`;
}

async function main(): Promise<void> {
  const evmKey = readHexKey(KEY_PATH);
  const client = new SuverseClient({ wallets: { evm: evmKey } });
  const body = JSON.stringify({ signature: SAMPLE_SIGNATURE });
  console.log(`POST ${URL_TARGET} (${body.length}B)`);
  const t0 = Date.now();
  try {
    const result = await client.fetch(URL_TARGET, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const dtMs = Date.now() - t0;
    const data = result.data;
    console.log(`OK in ${dtMs}ms`);
    console.log(`status=${result.response.status}`);
    if (data && typeof data === "object" && "summary" in (data as Record<string, unknown>)) {
      console.log(`summary=${(data as Record<string, unknown>)["summary"]}`);
    } else {
      const s = JSON.stringify(data).slice(0, 400);
      console.log(`body head=${s}`);
    }
    if (result.receipt) {
      console.log(
        `receipt: network=${result.receipt.network} tx=${result.receipt.transaction}`,
      );
    }
  } catch (err) {
    const dtMs = Date.now() - t0;
    console.error(`FAIL in ${dtMs}ms: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

await main();
