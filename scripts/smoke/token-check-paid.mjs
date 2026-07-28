// ONE real paid call to the live token-check endpoint on Base — proves
// the full path: validator -> preflight (fail-closed) -> settle on
// Base -> handler -> 200 with a real tx hash.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SuverseClient } from "@suverselabs/x402-client";

const OUT = "/tmp/token-check-build/samples";
mkdirSync(OUT, { recursive: true });

const key = readFileSync("/etc/suverse-pay/base-payer.key", "utf8").trim();
const client = new SuverseClient({ wallets: { evm: key } });

const token = "78B31QV1rtyoe2EYvVNjBVjeowyrtcH5FPTE4tCypump";
const t0 = Date.now();
const { data, response, payment } = await client.fetch(
  "https://proxy.suverse.io/v1/data/token-check",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  },
);
const ms = Date.now() - t0;
console.log(
  `status=${response.status} wall=${ms}ms`,
  `paid=${payment ? `${payment.network} ${payment.txHash} ${payment.amount}` : "NO"}`,
  `risk=${data?.verdict?.risk_level} conf=${data?.verdict?.confidence} elite=${data?.signals?.elite_flow?.status}`,
);
console.log(`summary: ${data?.verdict?.summary}`);
writeFileSync(
  `${OUT}/paid_base_call.json`,
  JSON.stringify({ token, status: response.status, wall_ms: ms, payment: payment ?? null, body: data }, null, 2),
);
