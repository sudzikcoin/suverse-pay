// One real $0.001-$0.01 USDC settle on Solana mainnet beta through
// each of the four new proxies under reskey_1166628d. Same Solana
// payer wallet as the multichain CoinGecko milestone
// (8Hy7D9NAiB9FDjS4wU3LhWu6EEQE6AE5xFaBxgyyYai6); SPL transfer signed
// by the buyer SDK, CDP acts as feePayer so the buyer's SOL balance
// is untouched.
//
// Black-box smoke: imports the published `@suverselabs/x402-client`
// from npm, not the workspace package, so it exercises exactly what
// an external customer sees. Installed copy lives under
// /tmp/coingecko-proxy-smoke/ alongside the prior multichain smokes;
// this file is the canonical reference (mirrored verbatim) that lands
// in the repo.
//
// PAYER_SOLANA_KEY_PATH env: path to a 64-byte JSON array (the secret
// key produced by `solana-keygen` / `Keypair.fromSecretKey`).

import { readFileSync } from "node:fs";
import { SuverseClient } from "@suverselabs/x402-client";

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const ENDPOINTS = [
  { slug: "tvl",          priceUsdc: 0.005, label: "DeFiLlama TVL" },
  { slug: "btc-spot",     priceUsdc: 0.001, label: "Binance BTC spot" },
  { slug: "coinbase-btc", priceUsdc: 0.001, label: "Coinbase BTC spot" },
  { slug: "eth-pools",    priceUsdc: 0.01,  label: "GeckoTerminal ETH pools" },
];

const secretPath = process.env.PAYER_SOLANA_KEY_PATH;
if (!secretPath) {
  console.error("ERROR: PAYER_SOLANA_KEY_PATH env required (path to 64-byte JSON array).");
  process.exit(2);
}
const arr = JSON.parse(readFileSync(secretPath, "utf8"));
if (!Array.isArray(arr) || arr.length !== 64) {
  console.error("ERROR: expected 64-byte JSON array at PAYER_SOLANA_KEY_PATH.");
  process.exit(2);
}
const secret = new Uint8Array(arr);

const client = new SuverseClient({
  wallets: { solana: secret },
  preferences: { preferredNetwork: SOLANA_MAINNET },
  signerOptions: {
    solana: {
      rpcEndpoint: "https://api.mainnet-beta.solana.com",
    },
  },
});

function summarizeBody(slug, body) {
  if (slug === "tvl" && Array.isArray(body)) {
    const top = body.slice(0, 3).map((p) => {
      const tvl = typeof p.tvl === "number" ? `$${(p.tvl / 1e9).toFixed(2)}B` : "?";
      return `${p.name} (${p.category}) ${tvl}`;
    });
    return `${body.length} protocols; top: ${top.join("; ")}`;
  }
  if (slug === "btc-spot") {
    return `${body.symbol} = ${body.price}`;
  }
  if (slug === "coinbase-btc") {
    return `${body?.data?.base}/${body?.data?.currency} = ${body?.data?.amount}`;
  }
  if (slug === "eth-pools" && body?.data) {
    const pools = body.data.slice(0, 3).map((p) => p.attributes?.name ?? p.id);
    return `${body.data.length} pools; first 3: ${pools.join("; ")}`;
  }
  return JSON.stringify(body).slice(0, 160);
}

function summarizeChallenge(accepts) {
  if (!Array.isArray(accepts)) return "<no accepts>";
  return accepts
    .map((a) => `${a.network}/${a.scheme}`)
    .join(", ");
}

const results = [];
for (const ep of ENDPOINTS) {
  const url = `https://proxy.suverse.io/v1/proxy/reskey_1166628d/${ep.slug}`;
  const probe = await fetch(url, { method: "GET", headers: { "User-Agent": "suverse-pay-smoke/1.0" } });
  const probeStatus = probe.status;
  let challengeSummary = "";
  if (probeStatus === 402) {
    try {
      const challenge = await probe.json();
      challengeSummary = summarizeChallenge(challenge.accepts);
    } catch {
      challengeSummary = "<unparseable 402>";
    }
  } else {
    await probe.body?.cancel();
  }

  const start = Date.now();
  let paid;
  try {
    paid = await client.fetch(url, {
      method: "GET",
      headers: { "User-Agent": "suverse-pay-smoke/1.0" },
    });
  } catch (err) {
    results.push({
      slug: ep.slug,
      label: ep.label,
      priceUsdc: ep.priceUsdc,
      probe402: probeStatus,
      probeAccepts: challengeSummary,
      paid200: null,
      error: `${err?.code ?? ""} ${err?.message ?? err}`.trim(),
    });
    continue;
  }
  const ms = Date.now() - start;
  results.push({
    slug: ep.slug,
    label: ep.label,
    priceUsdc: ep.priceUsdc,
    probe402: probeStatus,
    probeAccepts: challengeSummary,
    paid200: paid.response.status,
    durationMs: ms,
    network: paid.payment.network,
    txHash: paid.payment.txHash,
    payer: paid.payment.payer,
    payTo: paid.payment.payTo,
    amountAtomic: paid.payment.amount,
    dataSummary: summarizeBody(ep.slug, paid.data),
  });
}

console.log(JSON.stringify(results, null, 2));
