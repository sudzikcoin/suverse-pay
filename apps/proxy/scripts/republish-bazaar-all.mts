// One-shot indexing-settle for every active data endpoint so CDP
// Bazaar reindexes with the new keyword-dense description_bazaar
// strings. Pays the endpoint's listed priceAtomic in Base USDC (the
// proxy routes Base settles through facilitator.suverse.io →
// CoinbaseCdpAdapter, so each settle is the CDP "wake" the indexer
// reads).
//
// We don't care about the upstream response — the settle has already
// fired on the proxy URL by the time the proxy starts forwarding the
// request body to the upstream API. A 400 / 422 from the upstream
// (because we sent {}) does not affect the indexer.
//
// Usage:
//   PAYER_BASE_PRIVATE_KEY_PATH=/etc/suverse-pay/base-payer.key \
//   DATABASE_URL=postgres://… \
//     node --import tsx apps/proxy/scripts/republish-bazaar-all.mts
//
// Optional knobs:
//   ONLY_SLUG=base-contract-info  — process a single endpoint
//   SKIP_SLUGS=foo,bar             — skip these (csv)
//   PROXY_BASE=https://proxy.suverse.io
//   CONCURRENCY=3                  — default 1 (sequential) for safety

import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { SuverseClient } from "@suverselabs/x402-client";

const PROXY_BASE = process.env.SWAP_PROXY_BASE ?? process.env.PROXY_BASE ?? "https://proxy.suverse.io";
const BASE_CAIP2 = "eip155:8453";

interface Endpoint {
  slug: string;
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  priceAtomic: string;
}

interface Result {
  slug: string;
  url: string;
  httpStatus: number;
  settle: { txHash: string | null; payTo: string; amount: string } | null;
  durationMs: number;
  error?: string;
}

async function loadEndpoints(pool: Pool): Promise<Endpoint[]> {
  // Public-facing /v1/data/<public_slug> for v1+ rows; fall back to the
  // /v1/proxy/<reskey>/<endpoint_slug> form for legacy rows that never
  // got a public_slug backfill (migration 016).
  const { rows } = await pool.query<{
    endpoint_slug: string;
    original_method: Endpoint["method"];
    price_atomic: string;
    public_url: string | null;
    legacy_url: string;
  }>(
    `SELECT
       endpoint_slug,
       original_method,
       price_atomic::text AS price_atomic,
       CASE WHEN public_slug IS NOT NULL
            THEN 'https://proxy.suverse.io/v1/data/' || public_slug
            ELSE NULL END AS public_url,
       'https://proxy.suverse.io/v1/proxy/' || resource_key_id || '/' || endpoint_slug AS legacy_url
     FROM seller_proxy_configs
     WHERE is_active
       AND 'eip155:8453' = ANY(accepted_networks)
     ORDER BY endpoint_slug`,
  );
  return rows.map((r) => ({
    slug: r.endpoint_slug,
    url: r.public_url ?? r.legacy_url,
    method: r.original_method,
    priceAtomic: r.price_atomic,
  }));
}

async function republishOne(
  client: SuverseClient,
  ep: Endpoint,
): Promise<Result> {
  const t0 = Date.now();
  try {
    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method: ep.method,
      headers: {
        "content-type": "application/json",
        "User-Agent": "suverse-bazaar-reindex/1.0",
      },
    };
    if (ep.method !== "GET" && ep.method !== "DELETE") {
      init.body = "{}";
    }
    const res = await client.fetch(ep.url, init);
    return {
      slug: ep.slug,
      url: ep.url,
      httpStatus: res.response.status,
      settle: {
        txHash: res.payment.txHash ?? null,
        payTo: res.payment.payTo,
        amount: res.payment.amount,
      },
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      slug: ep.slug,
      url: ep.url,
      httpStatus: 0,
      settle: null,
      durationMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const keyPath = process.env.PAYER_BASE_PRIVATE_KEY_PATH;
  if (!keyPath) throw new Error("PAYER_BASE_PRIVATE_KEY_PATH required");
  const raw = readFileSync(keyPath, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      "PAYER_BASE_PRIVATE_KEY_PATH must point at a hex-encoded 32-byte private key",
    );
  }
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required");

  const pool = new Pool({ connectionString: dbUrl });
  const endpoints = await loadEndpoints(pool);
  await pool.end();

  const only = process.env.ONLY_SLUG?.trim();
  const skip = new Set(
    (process.env.SKIP_SLUGS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  );
  const queue = endpoints.filter((ep) => {
    if (only) return ep.slug === only;
    if (skip.has(ep.slug)) return false;
    return true;
  });

  console.log(`republishing ${queue.length} endpoint(s) via ${PROXY_BASE}`);
  console.log(
    `total cost if every settle clears: ${
      queue.reduce((acc, ep) => acc + BigInt(ep.priceAtomic), 0n).toString()
    } atomic USDC`,
  );
  console.log("---");

  const client = new SuverseClient({
    wallets: { evm: raw as `0x${string}` },
    preferences: { preferredNetwork: BASE_CAIP2 },
  });

  const results: Result[] = [];
  for (const ep of queue) {
    process.stdout.write(`[${ep.slug}] ${ep.method} ${ep.url} ($${
      (Number(ep.priceAtomic) / 1_000_000).toFixed(6)
    } USDC) ... `);
    const result = await republishOne(client, ep);
    results.push(result);
    if (result.settle?.txHash) {
      console.log(`OK ${result.httpStatus} tx=${result.settle.txHash.slice(0, 16)}… (${result.durationMs}ms)`);
    } else if (result.error) {
      console.log(`FAIL ${result.error.slice(0, 80)}`);
    } else {
      console.log(`HTTP ${result.httpStatus} no-settle (${result.durationMs}ms)`);
    }
  }

  console.log("\n=== summary ===");
  const settled = results.filter((r) => r.settle?.txHash);
  console.log(`settled:   ${settled.length}/${results.length}`);
  console.log(`failed:    ${results.filter((r) => r.error).length}`);
  console.log(`no-settle: ${results.filter((r) => !r.settle?.txHash && !r.error).length}`);
  const totalSpent = settled.reduce(
    (acc, r) => acc + BigInt(r.settle!.amount),
    0n,
  );
  console.log(`spent:     ${totalSpent.toString()} atomic USDC ($${
    (Number(totalSpent) / 1_000_000).toFixed(6)
  })`);

  console.log("\n=== failed ===");
  for (const r of results.filter((r) => r.error)) {
    console.log(`  ${r.slug}: ${r.error}`);
  }
}

await main();
