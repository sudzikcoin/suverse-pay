#!/usr/bin/env tsx
/**
 * Verify-after-deploy smoke for the P1 attribution fix.
 *
 * 1. Pay $0.005 USDC on Base to bitcoin-fees-recommended (free body,
 *    cheapest paid endpoint we have).
 * 2. Print the tx hash + payer wallet returned in PAYMENT-RESPONSE.
 *
 * Caller then runs the SQL verification block below against
 * suverse_pay to confirm the on-chain payment is correctly linked.
 *
 *   psql ... -c "
 *     SELECT prl.created_at, prl.facilitator_payment_id IS NOT NULL AS linked,
 *            fp.payer, fp.amount, fp.tx_hash
 *       FROM proxy_request_logs prl
 *  LEFT JOIN facilitator_payments fp ON fp.id = prl.facilitator_payment_id
 *      WHERE prl.tx_hash = '<TXHASH FROM STDOUT>'"
 */

import { readFileSync } from "node:fs";
import { SuverseClient } from "../../node_modules/.pnpm/@suverselabs+x402-client@0.1.0_typescript@5.9.3_zod@3.25.76/node_modules/@suverselabs/x402-client/dist/index.js";

const KEY_PATH =
  process.env["PAYER_BASE_PRIVATE_KEY_PATH"] ??
  "/etc/suverse-pay/base-payer.key";

function readHexKey(path: string): `0x${string}` {
  const raw = readFileSync(path, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`unexpected key shape in ${path}`);
  }
  return raw as `0x${string}`;
}

const evmKey = readHexKey(KEY_PATH);
const client = new SuverseClient({
  wallets: { evm: evmKey },
  preferences: { preferredNetwork: "eip155:8453" },
});

const url = "https://proxy.suverse.io/v1/data/bitcoin-fees-recommended";
const started = Date.now();
const paid = await client.fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
const durationMs = Date.now() - started;

const out = {
  durationMs,
  status: paid.response.status,
  network: paid.payment?.network ?? null,
  amountAtomic: paid.payment?.amount ?? null,
  txHash: paid.payment?.txHash ?? null,
  payer: paid.payment?.payer ?? null,
  sampledResponse:
    typeof paid.data === "object" && paid.data !== null
      ? Object.keys(paid.data as Record<string, unknown>).slice(0, 6)
      : null,
};
console.log(JSON.stringify(out, null, 2));
