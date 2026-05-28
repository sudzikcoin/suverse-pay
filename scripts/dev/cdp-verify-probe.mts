// Step 0.4 probe — verify CDP creds work against live API. Does NOT print
// secrets. Calls /supported via the production adapter path, captures the
// list of (scheme, network) kinds CDP advertises.
import { readFileSync } from "node:fs";
import { CoinbaseCdpAdapter } from "../../packages/adapters/coinbase-cdp/dist/index.js";

// minimal .env loader — only KEY=VALUE lines, no quoting/exports
const envText = readFileSync("/home/govhub/suverse-pay/.env", "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m) continue;
  if (process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const name = process.env.COINBASE_CDP_API_KEY_NAME;
const secret = process.env.COINBASE_CDP_API_KEY_SECRET;
if (!name || !secret) {
  console.error("missing COINBASE_CDP_API_KEY_NAME or COINBASE_CDP_API_KEY_SECRET in env");
  process.exit(2);
}

const cdp = new CoinbaseCdpAdapter({
  apiKeyName: name,
  apiKeySecret: secret,
  capabilities: [
    { network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", scheme: "exact" },
  ],
  estimatedFeeUsd: "0.001",
});

console.log("== healthCheck() ==");
const hc = await cdp.healthCheck();
console.log(JSON.stringify(hc, null, 2));

console.log("\n== discoverCapabilities() / raw kinds via /supported ==");
try {
  // Use the unsafe raw fetch to get the full /supported body, since
  // discoverCapabilities() filters by our static caps. We want every kind.
  const sig = await (cdp as any).signer.sign({
    method: "GET",
    host: "api.cdp.coinbase.com",
    path: "/platform/v2/x402/supported",
  });
  const r = await fetch("https://api.cdp.coinbase.com/platform/v2/x402/supported", {
    headers: { Authorization: `Bearer ${sig}` },
  });
  console.log("HTTP", r.status);
  const body = await r.json();
  // Trim to just kinds & extensions for legibility
  console.log(JSON.stringify({
    extensions: body.extensions,
    signers: body.signers,
    kindsCount: Array.isArray(body.kinds) ? body.kinds.length : null,
    kinds: body.kinds,
  }, null, 2));
} catch (e) {
  console.error("supported probe failed:", e);
  process.exit(1);
}
