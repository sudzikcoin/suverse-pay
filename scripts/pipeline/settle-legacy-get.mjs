#!/usr/bin/env node
// One paid GET settle each for the 2 legacy resource_server_configs slugs
// that index-batch can't reach (it POSTs; the legacy rail 405s on POST).
import { readFileSync } from "node:fs";
import { SuverseClient } from "/home/govhub/suverse-pay/packages/x402-client/dist/index.js";

const key = readFileSync(process.env.PAYER_BASE_PRIVATE_KEY_PATH ?? "/etc/suverse-pay/base-payer.key", "utf8").trim();
const client = new SuverseClient({ wallets: { evm: key }, preferences: { preferredNetwork: "eip155:8453" } });

for (const slug of ["coinbase-btc-spot", "geckoterminal-eth-pools"]) {
  const url = `https://proxy.suverse.io/v1/data/${slug}`;
  try {
    const res = await client.fetch(url, { headers: { "User-Agent": "suverse-bazaar-index/1.0" } });
    const status = res.response?.status ?? res.status;
    const body = res.response ? await res.response.text() : JSON.stringify(res);
    console.log(`${slug} HTTP ${status} receipt=${JSON.stringify(res.receipt ?? res.payment ?? null)} body=${body.slice(0, 150)}`);
  } catch (e) {
    console.log(`${slug} ERROR ${e?.message ?? e}`);
  }
}
