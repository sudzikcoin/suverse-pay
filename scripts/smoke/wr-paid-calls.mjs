// Four REAL calls to the live wallet-reputation endpoint — proves the
// full path: validator -> preflight (fail-closed) -> settle on Base ->
// handler -> 200. The invalid-address case must be rejected with 422
// BEFORE any 402 challenge, i.e. payment stays undefined.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SuverseClient } from "@suverselabs/x402-client";

const OUT = "/tmp/wr-build-report/samples";
mkdirSync(OUT, { recursive: true });

const key = readFileSync("/etc/suverse-pay/base-payer.key", "utf8").trim();
const client = new SuverseClient({ wallets: { evm: key } });

const CASES = [
  { name: "elite", wallet: "CBjwziSG9Z48MSAfqXNuKHyQ3JqrC963pNeivoUSAV5b" },
  { name: "weak", wallet: "CobPeS67MhQo1qa3ZwfMDGaUhcy5uBNKG2GnPkcZdQu8" },
  { name: "untracked", wallet: "26edvkZ99Lfs6LEwfSbfbJG17NM6z4BqrWMk7Z8hTe4D" },
  { name: "invalid", wallet: "this-is-not-base58-0OIl" },
];

for (const c of CASES) {
  const t0 = Date.now();
  try {
    const { data, response, payment } = await client.fetch(
      "https://proxy.suverse.io/v1/data/wallet-reputation",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: c.wallet }),
      },
    );
    const ms = Date.now() - t0;
    console.log(
      `[${c.name}] status=${response.status} wall=${ms}ms`,
      `paid=${payment ? `${payment.network} ${payment.txHash} ${payment.amount}` : "NO"}`,
      `tier=${data?.verdict?.tier ?? "-"} conf=${data?.verdict?.confidence ?? "-"}`,
    );
    writeFileSync(
      `${OUT}/${c.name}.json`,
      JSON.stringify({ wallet: c.wallet, status: response.status, wall_ms: ms, payment: payment ?? null, body: data }, null, 2),
    );
  } catch (err) {
    const ms = Date.now() - t0;
    console.log(`[${c.name}] threw after ${ms}ms:`, err?.message ?? err);
    writeFileSync(
      `${OUT}/${c.name}.json`,
      JSON.stringify({ wallet: c.wallet, error: String(err?.message ?? err), wall_ms: ms }, null, 2),
    );
  }
}
