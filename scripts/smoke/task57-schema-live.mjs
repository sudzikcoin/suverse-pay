// Task 57 live proof — per-config input schema on smart-money-netflow.
//
//   1. unpaid empty body        → 402 challenge WITH input_schema
//   2. unpaid {} (no required)  → 402 challenge (schema has no required)
//   3. unpaid wrong-typed param → 422 BEFORE the challenge
//   4. unpaid non-JSON          → 400 invalid_json_body
//   5. PAID wrong-typed param   → 422, payment never settles
//   6. PAID valid body          → 200, real Base settle (~$0.02)
import { readFileSync } from "node:fs";
import { SuverseClient } from "@suverselabs/x402-client";

const URL = "https://proxy.suverse.io/v1/data/smart-money-netflow";

async function raw(name, body) {
  const init = { method: "POST", headers: { "content-type": "application/json" } };
  if (body !== null) init.body = body;
  const res = await fetch(URL, init);
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* raw */ }
  console.log(`[${name}] status=${res.status} ` +
    `input_schema=${parsed && parsed.input_schema ? "yes" : "no"} ` +
    `error=${parsed?.error ?? "-"} detail=${parsed?.detail ?? "-"}`);
  return { status: res.status, body: parsed };
}

await raw("unpaid-empty", null);
await raw("unpaid-empty-object", "{}");
await raw("unpaid-wrong-type", JSON.stringify({ window_hours: "bogus" }));
await raw("unpaid-not-json", "garbage{{{");

const key = readFileSync("/etc/suverse-pay/base-payer.key", "utf8").trim();
const client = new SuverseClient({ wallets: { evm: key } });

// 5. paid attempt with an invalid body — must die on 422, no settle.
try {
  const { response, payment } = await client.fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ window_hours: "bogus" }),
  });
  console.log(`[paid-invalid] status=${response.status} paid=${payment ? "YES <-- BUG" : "no"}`);
} catch (err) {
  console.log(`[paid-invalid] threw (expected — non-402 stops the client): ${err?.message ?? err}`);
}

// 6. paid valid body — full settle + serve.
const t0 = Date.now();
const { data, response, payment } = await client.fetch(URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ window_hours: 24 }),
});
console.log(`[paid-valid] status=${response.status} wall=${Date.now() - t0}ms ` +
  `paid=${payment ? `${payment.network} ${payment.txHash ?? "?"} ${payment.amount ?? "?"}` : "NO"} ` +
  `tokens=${Array.isArray(data?.data) ? data.data.length : "?"}`);
