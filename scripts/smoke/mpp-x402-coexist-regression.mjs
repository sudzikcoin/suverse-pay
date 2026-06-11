// Task 39a regression: with the MPP/Tempo rail LIVE on
// wallet-reputation, a stock x402 buyer must settle exactly as
// before (the WWW-Authenticate header must be invisible to it).
// One real $0.03 Base settle through the public URL.
import { readFileSync } from "node:fs";
import { SuverseClient } from "@suverselabs/x402-client";

const key = readFileSync("/etc/suverse-pay/base-payer.key", "utf8").trim();
const client = new SuverseClient({ wallets: { evm: key } });

const t0 = Date.now();
const { data, response, payment } = await client.fetch(
  "https://proxy.suverse.io/v1/data/wallet-reputation",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wallet: "26edvkZ99Lfs6LEwfSbfbJG17NM6z4BqrWMk7Z8hTe4D",
    }),
  },
);
console.log("status:", response.status, `(${Date.now() - t0}ms)`);
console.log("payment:", payment
  ? { network: payment.network, amount: payment.amountAtomic ?? payment.amount, tx: payment.txHash ?? payment.transaction }
  : "(none)");
console.log("verdict tier:", data?.verdict?.tier, "| keys:", Object.keys(data ?? {}));
