#!/usr/bin/env tsx
/**
 * Dry-run for the response-branding middleware. Bypasses the buyer
 * SDK + facilitator + upstream entirely — just constructs a
 * settled-200 BrandingInput against the live Postgres and prints the
 * headers the middleware would emit on a real call.
 *
 * Used to verify the branding deploy when the facilitator is offline
 * (no live x402 settles possible) without burning the smoke wallet.
 */

// Scripts dir isn't a workspace, so bare specifiers can't resolve.
// Mirror the explicit-path pattern test-15-onchain-endpoints.mts uses.
import pg from "../../node_modules/.pnpm/pg@8.21.0/node_modules/pg/lib/index.js";
import {
  BrandingApplicator,
  loadBrandingConfig,
  type BrandingInput,
} from "../../apps/proxy/src/middleware/response-branding.js";
const { Pool } = pg;

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(1);
}

const SPECS: Array<Omit<BrandingInput, "rotationSeed">> = [
  {
    slug: "coinbase-btc-spot",
    acceptedNetworks: [
      "eip155:8453",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "cosmos:noble-1",
    ],
    displayName: "Bitcoin Spot Price",
    status: 200,
    isSwapEndpoint: false,
  },
  {
    slug: "cosmos-validator-stats",
    acceptedNetworks: [
      "eip155:8453",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "cosmos:noble-1",
    ],
    displayName: "Cosmos Validator Stats",
    status: 200,
    isSwapEndpoint: false,
  },
  {
    slug: "solana-tx-decoder",
    acceptedNetworks: [
      "eip155:8453",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "cosmos:noble-1",
    ],
    displayName: "Solana Tx Decoder",
    status: 200,
    isSwapEndpoint: false,
  },
];

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  // Use the same env vars the running proxy reads
  const cfg = loadBrandingConfig(process.env);
  console.log("config:", cfg);
  console.log();

  const applicator = new BrandingApplicator({ config: cfg, pool });
  for (const base of SPECS) {
    const input: BrandingInput = {
      ...base,
      // Stable seed so the rotation output is reproducible run-to-run
      rotationSeed: `dryrun:${base.slug}`,
    };
    console.log(`--- ${base.slug} ---`);
    const out = await applicator.apply(input);
    if (out.skipped) {
      console.log(`  skipped: ${out.skipped}`);
    } else {
      for (const [k, v] of Object.entries(out.headers)) {
        if (k === "X-Suverse-Related") {
          const parsed = JSON.parse(v);
          console.log(`  ${k}:`);
          for (const item of parsed) {
            console.log(`    - ${(item as { slug: string }).slug.padEnd(28)} ${(item as { url: string }).url}`);
          }
        } else {
          console.log(`  ${k}: ${v}`);
        }
      }
    }
    console.log();
  }
  await pool.end();
}

await main();
