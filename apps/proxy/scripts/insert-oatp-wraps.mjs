#!/usr/bin/env node
// One-shot admin script: insert the 3 OATP-wrap proxy endpoints under
// reskey_1166628d (sudzikgroup@gmail.com). Auto-approves the catalog
// listing so CDP Bazaar / our own search indexes pick them up.
//
//   DATABASE_URL=postgres://... node scripts/admin/insert-oatp-wraps.mjs
//
// Idempotent: each row is INSERT ... ON CONFLICT DO NOTHING on the
// (resource_key_id, endpoint_slug) unique index, so re-running on a
// db that already has them is a no-op.

import pg from "pg";
import { randomUUID } from "node:crypto";

const RESOURCE_KEY_ID = "reskey_1166628d";
const SUBMITTED_EMAIL = "sudzikgroup@gmail.com";

const SOL_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const COSMOS_USDC = "uusdc";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const PAY_TO_EVM = "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0";
const PAY_TO_SOLANA = "CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM";
const PAY_TO_COSMOS = "noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj";

const ACCEPTED_NETWORKS = [
  "eip155:8453",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "cosmos:noble-1",
];

const UPSTREAM_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

// Real OATP example responses (drained from each tool's 402 challenge
// extensions.bazaar.info.output.example just now), trimmed to be
// representative. Object shape — CDP schema silently rejects arrays.
const SAMPLE_TX_DECODER = {
  signature:
    "5KQwrPbwdL6PhXujxW37FSSbT5HG4d6V8c5jYrqWwG6QrBmbX2RhPZ8M9LrgDmBnYpZHVz9KvxWsyABcdEfGhij1",
  slot: 250123456,
  blockTime: 1710000000,
  fee: 5000,
  feeUsd: 0.00075,
  success: true,
  payer: "9xQeWvG816bUx9EPjHmaT23t3iWtVaLU4UY32x6yvLk1",
  summary: "Swap on Jupiter by 9xQe…vLk1 (2 token balance changes)",
  instructions: [
    {
      programId: "ComputeBudget111111111111111111111111111111",
      programName: "ComputeBudget",
      action: "setComputeUnitLimit",
    },
    {
      programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      programName: "Jupiter v6",
      action: null,
    },
  ],
  tokenChanges: [
    {
      owner: "9xQeWvG816bUx9EPjHmaT23t3iWtVaLU4UY32x6yvLk1",
      mint: SOL_USDC_MINT,
      amountChange: "-100000000",
      uiAmountChange: -100,
    },
    {
      owner: "9xQeWvG816bUx9EPjHmaT23t3iWtVaLU4UY32x6yvLk1",
      mint: "So11111111111111111111111111111111111111112",
      amountChange: "500000000",
      uiAmountChange: 0.5,
    },
  ],
};

const SAMPLE_TX_SIMULATOR = {
  success: true,
  err: null,
  logs: [
    "Program ComputeBudget111111111111111111111111111111 invoke [1]",
    "Program ComputeBudget111111111111111111111111111111 success",
    "Program 11111111111111111111111111111111 invoke [1]",
    "Program 11111111111111111111111111111111 success",
  ],
  unitsConsumed: 450,
  accountsTouched: null,
  sources: ["synapse:rpc"],
  queriedAt: "2026-04-26T10:00:00.000Z",
};

const SAMPLE_TOKEN_RISK = {
  mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  metadata: { name: "Bonk", symbol: "Bonk", decimals: 5 },
  authorities: { mintRenounced: true, freezeRenounced: true },
  distribution: {
    available: true,
    top10HolderPct: 40.52,
    holderCountApprox: 20,
  },
  liquidity: {
    priceUsd: 6.39e-6,
    liquidityUsd: 3260230,
    marketCapUsd: 562000000,
  },
  age: { ageDays: 686, createdAt: "2024-06-07T10:26:40.709Z" },
  risk: {
    score: 93,
    level: "safe",
    greenFlags: ["mint-renounced", "deep-liquidity"],
    flags: [],
  },
};

const SAMPLE_REQ_TX_DECODER = {
  signature:
    "5KQwrPbwdL6PhXujxW37FSSbT5HG4d6V8c5jYrqWwG6QrBmbX2RhPZ8M9LrgDmBnYpZHVz9KvxWsyABcdEfGhij1",
};

const SAMPLE_REQ_TX_SIMULATOR = {
  // Minimal base64-encoded Solana versioned-tx placeholder — enough for
  // OATP to parse the request even when the simulated tx itself fails.
  transaction:
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

const SAMPLE_REQ_TOKEN_RISK = {
  // BONK mainnet mint — same one used in the smoke test below.
  mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
};

const ENDPOINTS = [
  {
    endpointSlug: "solana-tx-decoder",
    publicSlug: "solana-tx-decoder",
    displayName: "Solana Transaction Decoder",
    description:
      "Decode any Solana transaction by signature into a structured human-readable summary. Returns invoked programs, token balance changes, fees in SOL and USD, instruction flow, and one-line summary. Perfect for AI agents analyzing wallet activity, debugging swap transactions, or building transaction history dashboards. Supports all Solana program types including Jupiter, Raydium, Orca, and SPL Token Program. Multi-network payment via SuVerse — pay with Base USDC, Solana USDC, or Cosmos USDC.",
    originalUrl: "https://api.oatp.cc/tools/tx_explainer",
    originalMethod: "POST",
    priceAtomic: "200000", // $0.20
    upstreamMaxPriceHuman: "0.200000",
    tags: ["solana", "transaction", "decode", "analytics", "explorer"],
    sampleResponse: SAMPLE_TX_DECODER,
    sampleRequest: SAMPLE_REQ_TX_DECODER,
  },
  {
    endpointSlug: "solana-tx-simulator",
    publicSlug: "solana-tx-simulator",
    displayName: "Solana Transaction Pre-Flight Simulator",
    description:
      "Simulate a Solana transaction before broadcasting to mainnet. Returns success/failure status, compute units consumed, full program logs, accounts touched, and detailed error messages if simulation fails. Essential for AI trading agents validating transactions before paying gas, MEV bots checking sandwich opportunities, wallet integrations preventing user errors, and DeFi protocols testing complex multi-step operations. Skip the cost of failed transactions — simulate first, broadcast only what will succeed.",
    originalUrl: "https://api.oatp.cc/tools/tx_simulator",
    originalMethod: "POST",
    priceAtomic: "400000", // $0.40
    upstreamMaxPriceHuman: "0.400000",
    tags: [
      "solana",
      "simulation",
      "transaction",
      "testing",
      "preflight",
      "mev",
    ],
    sampleResponse: SAMPLE_TX_SIMULATOR,
    sampleRequest: SAMPLE_REQ_TX_SIMULATOR,
  },
  {
    endpointSlug: "spl-token-safety-check",
    publicSlug: "spl-token-safety-check",
    displayName: "Solana Token Safety & Rug Risk Analyzer",
    description:
      "Comprehensive risk analysis for any Solana SPL token in milliseconds. Checks mint authority renouncement, freeze authority status, top-holder concentration, liquidity depth, market cap, token age, and 20+ security signals. Returns composite 0-100 risk score with explicit red flags (rug pull indicators) and green flags (legitimacy markers). Critical for AI trading agents avoiding scam tokens, portfolio safety bots screening holdings, sniper bots filtering launches, and DeFi protocols implementing on-chain due diligence before listing.",
    originalUrl: "https://api.oatp.cc/tools/token_risk_scan",
    originalMethod: "POST",
    priceAtomic: "1000000", // $1.00
    upstreamMaxPriceHuman: "1.000000",
    tags: ["solana", "token", "risk", "security", "rugpull", "safety", "spl"],
    sampleResponse: SAMPLE_TOKEN_RISK,
    sampleRequest: SAMPLE_REQ_TOKEN_RISK,
  },
];

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("ERROR: DATABASE_URL is required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const ep of ENDPOINTS) {
      const proxyConfigId = randomUUID();
      const searchText =
        `${ep.displayName} ${ep.description} ${ep.endpointSlug} ${ep.publicSlug}`.toLowerCase();
      const ins = await client.query(
        `INSERT INTO seller_proxy_configs
           (id, resource_key_id, endpoint_slug, public_slug,
            original_url, original_method, display_name, description,
            price_atomic, accepted_networks,
            pay_to_evm, pay_to_solana, pay_to_cosmos, pay_to_tron,
            forward_headers_encrypted, forward_auth_scheme, is_active,
            search_text,
            upstream_x402_enabled, upstream_x402_network,
            upstream_x402_max_price, upstream_signer_wallet)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 $11, $12, $13, NULL, NULL, 'static', true,
                 $14,
                 true, $15, $16, 'solana')
         ON CONFLICT (resource_key_id, endpoint_slug) DO NOTHING
         RETURNING id`,
        [
          proxyConfigId,
          RESOURCE_KEY_ID,
          ep.endpointSlug,
          ep.publicSlug,
          ep.originalUrl,
          ep.originalMethod,
          ep.displayName,
          ep.description,
          ep.priceAtomic,
          ACCEPTED_NETWORKS,
          PAY_TO_EVM,
          PAY_TO_SOLANA,
          PAY_TO_COSMOS,
          searchText,
          UPSTREAM_NETWORK,
          ep.upstreamMaxPriceHuman,
        ],
      );
      let insertedId;
      if (ins.rows.length === 0) {
        // Row existed → fetch its id so we can keep the matching
        // catalog_listings in sync (idempotent UPDATE below).
        const existing = await client.query(
          `SELECT id FROM seller_proxy_configs
             WHERE resource_key_id = $1 AND endpoint_slug = $2`,
          [RESOURCE_KEY_ID, ep.endpointSlug],
        );
        insertedId = existing.rows[0].id;
        console.log(
          `= seller_proxy_configs ${ep.endpointSlug} already present id=${insertedId}`,
        );
      } else {
        insertedId = ins.rows[0].id;
        console.log(`+ seller_proxy_configs ${ep.endpointSlug} id=${insertedId}`);
      }

      // Catalog listing — auto-approved so CDP Bazaar + our own
      // /api/search index it without admin click-through.
      const catalogId = randomUUID();
      // unique slug per migration 016 conventions: <kebab-name>-<6 hex>.
      const slug =
        ep.publicSlug + "-" + randomUUID().replace(/-/g, "").slice(0, 6);
      const networksWithUsdc = [
        "eip155:8453",
        "solana:mainnet",
        "cosmos:noble-1",
      ];
      const endpointUrl = `https://proxy.suverse.io/v1/data/${ep.publicSlug}`;
      // Idempotent: if a catalog row already points at this proxy_config_id,
      // UPDATE it in place (re-runs after a schema bump update sample_*).
      const existingCatalog = await client.query(
        `SELECT id, slug FROM catalog_listings WHERE proxy_config_id = $1`,
        [insertedId],
      );
      if (existingCatalog.rows.length > 0) {
        const exId = existingCatalog.rows[0].id;
        const exSlug = existingCatalog.rows[0].slug;
        await client.query(
          `UPDATE catalog_listings
              SET title = $1, description = $2, endpoint_url = $3,
                  tags = $4, price_atomic_min = $5, price_atomic_max = $5,
                  networks = $6, resource_key_id = $7,
                  sample_response_json = $8, sample_request_json = $9,
                  status = 'approved', updated_at = NOW()
            WHERE id = $10`,
          [
            ep.displayName,
            ep.description,
            endpointUrl,
            ep.tags,
            ep.priceAtomic,
            networksWithUsdc,
            RESOURCE_KEY_ID,
            JSON.stringify(ep.sampleResponse),
            JSON.stringify(ep.sampleRequest),
            exId,
          ],
        );
        console.log(`~ catalog_listings ${exSlug} updated`);
      } else {
        await client.query(
          `INSERT INTO catalog_listings
             (id, title, description, endpoint_url, category, tags,
              price_atomic_min, price_atomic_max, price_unit,
              networks, regions, region_restrictions, is_verified,
              resource_key_id, facilitator_url, submitted_email,
              status, reviewed_by, reviewed_at,
              slug, sample_response_json, sample_request_json,
              proxy_config_id)
           VALUES ($1, $2, $3, $4, 'crypto-onchain', $5,
                   $6, $6, 'per-call',
                   $7, ARRAY['global'], '{}', true,
                   $8, 'https://facilitator.suverse.io', $9,
                   'approved', 'auto-admin', NOW(),
                   $10, $11, $12, $13)`,
          [
            catalogId,
            ep.displayName,
            ep.description,
            endpointUrl,
            ep.tags,
            ep.priceAtomic,
            networksWithUsdc,
            RESOURCE_KEY_ID,
            SUBMITTED_EMAIL,
            slug,
            JSON.stringify(ep.sampleResponse),
            JSON.stringify(ep.sampleRequest),
            insertedId,
          ],
        );
        console.log(`+ catalog_listings ${slug} → ${endpointUrl}`);
      }
    }
    await client.query("COMMIT");
    console.log("DONE");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("FAILED:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
