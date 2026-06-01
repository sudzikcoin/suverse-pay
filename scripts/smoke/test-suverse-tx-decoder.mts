#!/usr/bin/env tsx
/**
 * Smoke test: first-party SuVerse Solana tx decoder.
 *
 * Spends $0.05 USDC on Base from PAYER_BASE_PRIVATE_KEY_PATH against
 * https://proxy.suverse.io/v1/data/suverse-solana-tx-decoder. The
 * endpoint is internal_handler='helius_tx_decoder' — no upstream x402,
 * so the proxy fans out to Helius Enhanced Transactions on our key
 * and serializes the result to the buyer.
 *
 * After the call, inspect facilitator_payments for exactly one inbound
 * settle row (Base USDC, amount=50000, payTo=0x260fbe…). There should
 * be no outbound row.
 *
 * Fresh signature is fetched at boot from Jupiter v6 program via a
 * public Solana RPC, so the decoder always has a real recent tx.
 *
 * Run from /home/govhub/suverse-pay; reads PAYER_BASE_PRIVATE_KEY_PATH
 * (default /etc/suverse-pay/base-payer.key) and SMOKE_TX_DECODER_URL
 * (default the suverse-* slug) from the env.
 */

import { readFileSync } from "node:fs";
import { SuverseClient } from "../../node_modules/.pnpm/@suverselabs+x402-client@0.1.0_typescript@5.9.3_zod@3.25.76/node_modules/@suverselabs/x402-client/dist/index.js";

const URL_TARGET =
  process.env["SMOKE_TX_DECODER_URL"] ??
  "https://proxy.suverse.io/v1/data/suverse-solana-tx-decoder";

const KEY_PATH =
  process.env["PAYER_BASE_PRIVATE_KEY_PATH"] ??
  "/etc/suverse-pay/base-payer.key";

// Prefer our Helius RPC (no rate limit headaches); fall back to the
// public mainnet RPC if HELIUS_API_KEY isn't around.
const HELIUS_KEY = process.env["HELIUS_API_KEY"] ?? "";
const SOLANA_RPC =
  process.env["SOLANA_RPC_URL"] ??
  (HELIUS_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
    : "https://api.mainnet-beta.solana.com");

const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

function readHexKey(path: string): `0x${string}` {
  const raw = readFileSync(path, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`unexpected key shape in ${path}`);
  }
  return raw as `0x${string}`;
}

async function fetchFreshSignature(): Promise<string> {
  if (process.env["SMOKE_TX_DECODER_SIGNATURE"]) {
    return process.env["SMOKE_TX_DECODER_SIGNATURE"];
  }
  const res = await fetch(SOLANA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: [JUPITER_V6, { limit: 1 }],
    }),
  });
  const body = (await res.json()) as {
    result?: Array<{ signature: string; err: unknown }>;
  };
  const first = body.result?.find((r) => !r.err);
  if (!first) throw new Error("no fresh signatures returned");
  return first.signature;
}

async function main(): Promise<void> {
  const signature = await fetchFreshSignature();
  console.log(`signature=${signature}`);

  const evmKey = readHexKey(KEY_PATH);
  const client = new SuverseClient({ wallets: { evm: evmKey } });
  const body = JSON.stringify({ signature });
  console.log(`POST ${URL_TARGET} (${body.length}B)`);
  const t0 = Date.now();
  try {
    const result = await client.fetch(URL_TARGET, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const dtMs = Date.now() - t0;
    const data = result.data as Record<string, unknown> | undefined;
    console.log(`OK in ${dtMs}ms status=${result.response.status}`);
    if (data && typeof data === "object") {
      console.log(`signature=${data["signature"] as string | undefined}`);
      console.log(`slot=${data["slot"] as number | undefined}`);
      console.log(`type=${data["type"] as string | undefined}`);
      console.log(`summary=${data["summary"] as string | undefined}`);
      const transfers = data["tokenTransfers"];
      if (Array.isArray(transfers)) {
        console.log(`tokenTransfers.length=${transfers.length}`);
      }
    } else {
      console.log(`body=${JSON.stringify(data).slice(0, 200)}`);
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
