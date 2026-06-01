#!/usr/bin/env tsx
/**
 * Re-smoke just the three endpoints that failed in the first run of
 * test-15-onchain-endpoints.mts. Cheap (~$0.35) and isolates the
 * fixes — GoPlus auth removed, holder timeout bumped, real validator
 * address.
 */

import { readFileSync } from "node:fs";
import { SuverseClient } from "../../node_modules/.pnpm/@suverselabs+x402-client@0.1.0_typescript@5.9.3_zod@3.25.76/node_modules/@suverselabs/x402-client/dist/index.js";

const KEY_PATH =
  process.env["PAYER_BASE_PRIVATE_KEY_PATH"] ??
  "/etc/suverse-pay/base-payer.key";

const evmKey = readFileSync(KEY_PATH, "utf8").trim() as `0x${string}`;
const client = new SuverseClient({
  wallets: { evm: evmKey },
  preferences: { preferredNetwork: "eip155:8453" },
});

const targets = [
  {
    slug: "evm-token-risk-base",
    body: { contract_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    responseKey: "riskScore",
  },
  {
    slug: "base-token-holders",
    body: { contract_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    responseKey: "sampleSize",
  },
  {
    slug: "cosmos-validator-stats",
    body: {
      chain: "cosmoshub",
      validator: "cosmosvaloper1qphf0ferqcch0jca9hlqfm3x0eds3dpkcvpafp",
    },
    responseKey: "operatorAddress",
  },
];

const results: Array<Record<string, unknown>> = [];
for (const t of targets) {
  const url = `https://proxy.suverse.io/v1/data/${t.slug}`;
  const start = Date.now();
  try {
    const paid = await client.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(t.body),
    });
    const dt = Date.now() - start;
    const data = paid.data as Record<string, unknown> | undefined;
    const v = data?.[t.responseKey];
    results.push({
      slug: t.slug,
      durationMs: dt,
      status: paid.response.status,
      txHash: paid.payment?.txHash ?? null,
      network: paid.payment?.network ?? null,
      amountAtomic: paid.payment?.amount ?? null,
      sampledField: t.responseKey,
      sampledValue: typeof v === "object" ? "<object>" : (v ?? null),
      ok: paid.response.status === 200,
    });
  } catch (err) {
    results.push({
      slug: t.slug,
      durationMs: Date.now() - start,
      ok: false,
      error: (err as Error).message,
    });
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log(JSON.stringify(results, null, 2));
