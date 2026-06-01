#!/usr/bin/env tsx
/**
 * Real $0.005 - $0.20 USDC settle on Base for each of the 15 new
 * Base / Cosmos / Bitcoin first-party endpoints under reskey_1166628d.
 * Buyer wallet is the standard Claude-owned PAYER_BASE_PRIVATE_KEY_PATH.
 *
 * Expected total spend: ~$0.97 (Base side). All endpoints accept
 * eip155:8453 alongside Solana + Cosmos so the client always picks
 * Base USDC here.
 *
 * Black-box smoke — uses the workspace `@suverselabs/x402-client`.
 */

import { readFileSync } from "node:fs";
// Direct path import — the scripts dir is not a workspace, so a
// bare specifier can't resolve. Mirror the pattern used in
// test-suverse-tx-decoder.mts.
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

interface EndpointSpec {
  slug: string;
  priceUsdc: number;
  body: Record<string, unknown> | null;
  responseKey: string;
}

const ENDPOINTS: EndpointSpec[] = [
  // Base
  {
    slug: "base-tx-decoder",
    priceUsdc: 0.05,
    body: {
      tx_hash:
        "0xb044ab1d32d52d3ebb3689f651071d8d4f9ae0aba55afce64c5e692efdee1ab6",
    },
    responseKey: "hash",
  },
  {
    slug: "evm-token-risk-base",
    priceUsdc: 0.2,
    body: {
      contract_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    },
    responseKey: "riskScore",
  },
  {
    slug: "base-wallet-history",
    priceUsdc: 0.1,
    body: { address: "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0", limit: 10 },
    responseKey: "count",
  },
  {
    slug: "base-token-holders",
    priceUsdc: 0.1,
    body: { contract_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    responseKey: "sampleSize",
  },
  {
    slug: "base-contract-info",
    priceUsdc: 0.05,
    body: { contract_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    responseKey: "verified",
  },
  // Cosmos
  {
    slug: "cosmos-tx-decoder",
    priceUsdc: 0.05,
    body: { chain: "cosmoshub", tx_hash: "__FETCH__" },
    responseKey: "messageCount",
  },
  {
    slug: "cosmos-wallet-balance",
    priceUsdc: 0.1,
    body: { address: "cosmos1tygms3xhhs3yv487phx3dw4a95jn7t7lpm470r" },
    responseKey: "balanceCount",
  },
  {
    slug: "cosmos-validator-stats",
    priceUsdc: 0.05,
    body: {
      chain: "cosmoshub",
      // First validator returned by /validators?status=BOND_STATUS_BONDED;
      // the placeholder we used initially had a bad bech32 checksum.
      validator: "cosmosvaloper1qphf0ferqcch0jca9hlqfm3x0eds3dpkcvpafp",
    },
    responseKey: "operatorAddress",
  },
  {
    slug: "cosmos-ibc-tracker",
    priceUsdc: 0.1,
    body: { chain: "cosmoshub", tx_hash: "__FETCH__" },
    responseKey: "ibcDetected",
  },
  {
    slug: "cosmos-chain-info",
    priceUsdc: 0.05,
    body: { chain: "cosmoshub" },
    responseKey: "latestHeight",
  },
  // Bitcoin
  {
    slug: "bitcoin-tx-decoder",
    priceUsdc: 0.05,
    body: {
      txid: "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b",
    },
    responseKey: "isCoinbase",
  },
  { slug: "bitcoin-fees-recommended", priceUsdc: 0.005, body: {}, responseKey: "satsPerVbyte" },
  {
    slug: "bitcoin-address-info",
    priceUsdc: 0.05,
    body: { address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" },
    responseKey: "addressType",
  },
  { slug: "bitcoin-mempool-stats", priceUsdc: 0.005, body: {}, responseKey: "tipHeight" },
  {
    slug: "bitcoin-block-info",
    priceUsdc: 0.01,
    body: { height: 800000 },
    responseKey: "minerPool",
  },
];

async function fetchRecentCosmosTxHash(): Promise<string> {
  // Walk back recent cosmoshub blocks, query the tx search via the
  // SDK v0.50 `query=` parameter (the older `events=` form 504s on
  // publicnode). Returns the first non-empty match.
  const lcdBase = "https://cosmos-rest.publicnode.com";
  const tipRes = await fetch(
    `${lcdBase}/cosmos/base/tendermint/v1beta1/blocks/latest`,
  );
  const tip = (await tipRes.json()) as {
    block?: { header?: { height?: string } };
  };
  const tipHeight = Number(tip.block?.header?.height ?? "0");
  if (!tipHeight) throw new Error("could not read cosmoshub tip height");
  for (let h = tipHeight - 1; h > tipHeight - 50; h -= 1) {
    const blockRes = await fetch(
      `${lcdBase}/cosmos/base/tendermint/v1beta1/blocks/${h}`,
    );
    if (!blockRes.ok) continue;
    const block = (await blockRes.json()) as {
      block?: { data?: { txs?: string[] } };
    };
    const txs = block.block?.data?.txs ?? [];
    if (txs.length === 0) continue;
    const u = new URL(`${lcdBase}/cosmos/tx/v1beta1/txs`);
    u.searchParams.set("query", `tx.height=${h}`);
    u.searchParams.set("pagination.limit", "1");
    const searchRes = await fetch(u.toString());
    if (!searchRes.ok) continue;
    const search = (await searchRes.json()) as {
      tx_responses?: Array<{ txhash?: string }>;
    };
    const hash = search.tx_responses?.[0]?.txhash;
    if (hash) return hash;
  }
  throw new Error("no tx found in recent cosmoshub blocks");
}

async function fetchRecentIbcTxHash(): Promise<string | null> {
  // Walk back blocks looking for a tx that carries an IBC MsgTransfer.
  // Falls back to any recent tx if nothing's found in the scan window
  // (the IBC tracker still 200s with ibcDetected:false).
  const lcdBase = "https://cosmos-rest.publicnode.com";
  try {
    const tipRes = await fetch(
      `${lcdBase}/cosmos/base/tendermint/v1beta1/blocks/latest`,
    );
    const tip = (await tipRes.json()) as {
      block?: { header?: { height?: string } };
    };
    const tipHeight = Number(tip.block?.header?.height ?? "0");
    if (!tipHeight) return null;
    for (let h = tipHeight - 1; h > tipHeight - 100; h -= 1) {
      const u = new URL(`${lcdBase}/cosmos/tx/v1beta1/txs`);
      u.searchParams.set(
        "query",
        `tx.height=${h} AND message.action='/ibc.applications.transfer.v1.MsgTransfer'`,
      );
      u.searchParams.set("pagination.limit", "1");
      const res = await fetch(u.toString());
      if (!res.ok) continue;
      const body = (await res.json()) as {
        tx_responses?: Array<{ txhash?: string }>;
      };
      const hash = body.tx_responses?.[0]?.txhash;
      if (hash) return hash;
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveBodies(specs: EndpointSpec[]): Promise<EndpointSpec[]> {
  const cosmosTxHash = await fetchRecentCosmosTxHash();
  const ibcTxHash = (await fetchRecentIbcTxHash()) ?? cosmosTxHash;
  return specs.map((s) => {
    if (!s.body) return s;
    const newBody = { ...s.body };
    if (s.slug === "cosmos-tx-decoder") newBody["tx_hash"] = cosmosTxHash;
    if (s.slug === "cosmos-ibc-tracker") newBody["tx_hash"] = ibcTxHash;
    return { ...s, body: newBody };
  });
}

const evmKey = readHexKey(KEY_PATH);
const client = new SuverseClient({
  wallets: { evm: evmKey },
  preferences: { preferredNetwork: "eip155:8453" },
});

const specs = await resolveBodies(ENDPOINTS);
const results: Array<Record<string, unknown>> = [];
let totalSpentUsdc = 0;

for (const ep of specs) {
  const url = `https://proxy.suverse.io/v1/data/${ep.slug}`;
  const body = ep.body ? JSON.stringify(ep.body) : "{}";
  const start = Date.now();
  let entry: Record<string, unknown> = {
    slug: ep.slug,
    priceUsdc: ep.priceUsdc,
  };
  try {
    const paid = await client.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const dt = Date.now() - start;
    const data = paid.data as Record<string, unknown> | undefined;
    const v = data?.[ep.responseKey];
    entry = {
      ...entry,
      durationMs: dt,
      status: paid.response.status,
      txHash: paid.payment?.txHash ?? null,
      network: paid.payment?.network ?? null,
      amountAtomic: paid.payment?.amount ?? null,
      sampledField: ep.responseKey,
      sampledValue: typeof v === "object" ? "<object>" : (v ?? null),
      ok: paid.response.status === 200,
    };
    if (paid.response.status === 200) totalSpentUsdc += ep.priceUsdc;
  } catch (err) {
    const dt = Date.now() - start;
    entry = {
      ...entry,
      durationMs: dt,
      ok: false,
      error: (err as Error).message,
    };
  }
  results.push(entry);
  // Brief breathing room between calls so we don't dogpile the
  // facilitator + RPC.
  await new Promise((r) => setTimeout(r, 500));
}

console.log(JSON.stringify({ totalSpentUsdc, results }, null, 2));
