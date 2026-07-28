// One REAL paid call to the live endpoint — proves the full path:
// preflight (fail-closed gate) -> settle on Base -> handler -> 200.
import { readFileSync, writeFileSync } from "node:fs";
import { SuverseClient } from "@suverselabs/x402-client";

const key = readFileSync("/etc/suverse-pay/base-payer.key", "utf8").trim();
const client = new SuverseClient({ wallets: { evm: key } });

const t0 = Date.now();
const { data, response, payment } = await client.fetch(
  "https://proxy.suverse.io/v1/data/crypto-market-pulse",
  { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
);
const ms = Date.now() - t0;
console.log("status:", response.status, "wall:", ms + "ms");
console.log("payment:", payment?.network, payment?.txHash, payment?.amount);
console.log("regime:", data?.verdict?.regime, "confidence:", data?.verdict?.confidence);
writeFileSync("/tmp/cmp-build-report/samples/pulse-paid-call.json", JSON.stringify({ payment, body: data }, null, 2));
