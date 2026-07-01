#!/usr/bin/env node
/**
 * gen-batch-010.mjs — emit seed SQL + index manifest for the 5 verdict
 * products (one call = one finished answer an agent acts on), priced
 * in the $0.25-0.75 clearing band per the 2026-07 x402 economy research.
 * These are bespoke internal_handler endpoints registered in registry.ts;
 * the declarative wrap-batch pipeline does not apply. Idempotent UPSERT,
 * ASCII copy, price lands in BOTH seller_proxy_configs.price_atomic and
 * catalog_listings.price_atomic_min/max.
 */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RESKEY = "reskey_1166628d";
const PAY_EVM = "0xe90316121189715CDc2515B7C2673658b810b751"; // active pool payTo (payto-005)
const PAY_SOL = "CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM";
const PAY_COS = "noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj";
const NET_CFG = ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "cosmos:noble-1"];
const NET_CAT = ["eip155:8453", "solana:mainnet", "cosmos:noble-1"];

const rows = [
  {
    slug: "polymarket-smart-sheet", handler: "polymarket_smart_sheet", price: 750000,
    category: "prediction-markets",
    tags: ["polymarket", "smart-money", "prediction-markets", "whale-tracking", "trader-skill", "market-edge", "verdict"],
    title: "Polymarket Smart-Money Sheet",
    desc: "Joins the four Polymarket Smart Money endpoints (smart-bias, whale-entries, trader-skill, position-holders) into a single ranked sheet of every active market where tracked smart money currently has an edge. Each row carries direction, conviction-based confidence, whale flow, entrant skill and holder concentration, topped by a verdict with the single strongest pick. The critical bias source is proven before payment settles; enrichment sources degrade gracefully and are disclosed in data_quality. Post-settle failures are auto-refunded.",
    bazaar: "One call, one ranked smart-money sheet: every active Polymarket market with an edge, scored by bias, conviction, whale entries, trader skill and holder concentration. Verdict + top pick included. Fail-closed critical source, auto-refund on failure.",
    sample: { limit: 20, category: "all", time_window: "24h" },
    resp: { verdict: { markets_with_edge: 6, top_pick: { market_id: "0x8f3a...", title: "Will BTC close above $150k in 2026?", direction: "yes", bias_score: 80, confidence: "high" }, summary: "Smart money shows an edge in 6 active Polymarket markets over the last 24h.", confidence: "high" }, sheet: [{ rank: 1, market_id: "0x8f3a...", title: "Will BTC close above $150k in 2026?", category: "crypto", bias_score: 80, direction: "yes", confidence: "high", conviction_score: 70, whale_entries: { window: "24h", count: 2, net_usd: 12000, dominant_side: "YES" } }], signals: { sources_used: ["smart_bias", "whale_entries", "trader_skill", "position_holders"], whale_totals: { window: "24h", entries: 3, net_usd: 9000 } }, data_quality: { stale_sources: [], computed_at: "2026-07-01T13:00:00.000Z", sheet_rows: 20 } },
  },
  {
    slug: "x402-liveness-check", handler: "x402_liveness_check", price: 250000,
    category: "infrastructure",
    tags: ["x402", "liveness", "health-check", "uptime", "402-challenge", "monitoring", "verdict"],
    title: "x402 Endpoint Liveness Check",
    desc: "Sends one unpaid GET/POST/HEAD probe to any x402 resource URL and grades its 402 surface: ALIVE means a well-formed 402 with valid accepts and extracted minimum USD price; DEGRADED means reachable but not a clean x402 surface (non-402, redirect, malformed challenge, or slow); DEAD means network error, timeout, or 5xx. Private, loopback, link-local, CGNAT and metadata targets are blocked before settlement so you are never charged for an unprobeable request. Post-settle failures are auto-refunded.",
    bazaar: "Probe any x402 resource URL without paying it: ALIVE/DEGRADED/DEAD verdict on its 402 surface - challenge validity, min price, networks, payTo, latency, bazaar extension. SSRF-guarded, no payment ever sent to the target. Auto-refund on failure.",
    sample: { resource_url: "https://proxy.suverse.io/v1/data/crypto-market-pulse", method: "POST" },
    resp: { resource_url: "https://proxy.suverse.io/v1/data/crypto-market-pulse", verdict: { status: "ALIVE", reason: "valid_x402_challenge", checked_at: "2026-07-02T01:00:00.000Z" }, signals: { http_status: 402, latency_ms: 220, x402_version: 1, accepts_count: 2, accepts_valid: true, price_usd_min: 0.1, networks: ["base", "solana"], bazaar_extension_present: true, input_schema_declared: true }, data_quality: { probe_method: "POST", timeout_ms: 8000, redirect_policy: "manual" }, raw: { challenge_body: "{\"x402Version\":1,...}" } },
  },
  {
    slug: "base-token-forensics", handler: "base_token_forensics", price: 350000,
    category: "crypto-security",
    tags: ["base", "token", "forensics", "rugcheck", "holders", "verification", "verdict"],
    title: "Base Token Forensics",
    desc: "POST a Base token contract address and get a merged forensic dossier from Etherscan verification data, Blockscout holder distribution, and decoded on-chain activity. A single explicit rule table yields a CLEAN, WATCH, or RED-FLAG verdict with per-source data-quality disclosure. Critical sources are proven before settlement; degraded sources are flagged, never silently omitted. Post-settle failures are auto-refunded.",
    bazaar: "Base token forensics in one call: verification status, top-holder concentration, contract age, and decoded recent activity merged into a single CLEAN / WATCH / RED-FLAG verdict for any Base (eip155:8453) token contract. Fail-closed critical source, auto-refund on failure.",
    sample: { contract_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    resp: { contract_address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", verdict: { status: "CLEAN", flags: [], summary: "CLEAN: verified contract with distributed holdings (top-10 hold 20.0% of supply across 5000 holders) and no red flags.", confidence: "high" }, signals: { contract: { name: "USD Coin", symbol: "USDC", is_verified: true, age_days: 1065 }, holders: { holder_count: 5000, top1_share_pct: 2, top10_share_pct: 20 }, recent_activity: [{ tx_hash: "0xab...", status: "success", summary: "1 ERC20 transfer(s) on Base" }] }, data_quality: { stale_sources: [], computed_at: "2026-07-02T01:02:13.000Z", sources: { contract_info: "ok", holders: "ok", activity: "ok" } } },
  },
  {
    slug: "token-entry-verdict", handler: "token_entry_verdict", price: 500000,
    category: "crypto-trading-signals",
    tags: ["solana", "token-safety", "smart-money", "entry-signal", "netflow", "rugcheck", "verdict"],
    title: "Token Entry Verdict (Solana)",
    desc: "Combines the token-check safety analysis with fresh smart-money netflow (24h/7d from our trade tape, 30d cache) and recent-trader label context into a single ENTER/CAUTION/AVOID call for any Solana mint. The safety layer is fail-closed pre-settlement - if critical sources are down you are never charged - and non-critical layers degrade honestly with named stale sources and reduced confidence. Post-settle failures are auto-refunded.",
    bazaar: "One-call ENTER/CAUTION/AVOID entry verdict for a Solana token mint: full token-check safety screen plus smart-money 24h/7d/30d netflow, ring/bot trader context, and tape-freshness honesty. Fail-closed critical path with auto-refund on failure.",
    sample: { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
    resp: { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", verdict: { decision: "ENTER", summary: "ENTER: safety is clean and smart money is net accumulating (+$500 24h, +$2500 7d) with no ring/bot dominance among recent traders.", confidence: "high", decisive_factors: ["safety_clean", "smart_money_accumulation", "no_ring_or_bot_dominance"] }, signals: { safety: { verdict: "low", flags: [] }, smart_money: { netflow_24h_usd: 500, netflow_7d_usd: 2500, netflow_30d_usd: 4321.5, direction: "accumulation" }, trader_context: { labeled_share: 0.5, ring_or_bot_dominated: false } }, data_quality: { tape_freshness: { hours_since_last_chain_trade: 1, stale: false }, stale_sources: [], windows_used: ["24h", "7d", "30d"], computed_at: "2026-07-02T01:06:00Z" } },
  },
  {
    slug: "market-regime-verdict", handler: "market_regime_verdict", price: 500000,
    category: "market-intelligence",
    tags: ["market-regime", "risk-on", "risk-off", "smart-money", "funding-rates", "stablecoins", "verdict"],
    title: "Crypto Market Regime Verdict",
    desc: "Aggregates five market drivers - fear-greed sentiment, BTC momentum, on-chain smart-money netflow, Binance perp funding, and DeFiLlama stablecoin float - into a single weighted risk_on/risk_off/chop regime verdict with per-driver attribution and evidence. Critical sources are health-proven before your payment settles; non-critical drivers degrade gracefully and lower confidence instead of failing the call. Optional detail:summary trims the raw payload. Post-settle failures are auto-refunded.",
    bazaar: "One call, one answer: is crypto risk-on, risk-off, or chop? Weighted verdict from fear-greed, BTC momentum, smart-money netflow, BTC/ETH perp funding and stablecoin float, with driver attribution and numeric confidence. Fail-closed critical path, auto-refund on failure.",
    sample: { detail: "full" },
    resp: { verdict: { regime: "risk_on", score: 0.6, summary: "Risk-on tape (score +0.6), led by btc_momentum (bullish) and fear_greed (bullish).", confidence: 0.88 }, signals: { drivers: [{ name: "btc_momentum", direction: "bullish", weight: 0.25, value: 4, evidence: "BTC +4% 24h", fresh: true }], smart_money_confirmation: { direction: "inflow", agrees_with_regime: true }, base_pulse: { regime_from_pulse: "confirmed_rally", sentiment: { value: 80, classification: "Greed" } } }, data_quality: { stale_sources: [], computed_at: "2026-07-01T00:00:00.000Z", drivers_fresh_count: 5 }, raw: { funding: { rates: [] }, stablecoins: { top_n_total_supply_usd: 140000000000 } } },
  },
];

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const arr = (a) => `ARRAY[${a.map(q).join(",")}]`;
const jsn = (o) => q(JSON.stringify(o));
const url = (slug) => `https://proxy.suverse.io/v1/data/${slug}`;

const blocks = rows.map((r) => `-- ${r.slug} (internal_handler=${r.handler}, $${(r.price / 1e6).toFixed(2)})
WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug, original_url, original_method,
    display_name, description, description_bazaar, price_atomic, accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos, forward_auth_scheme, is_active,
    upstream_x402_enabled, internal_handler
  ) VALUES (
    gen_random_uuid(), '${RESKEY}', ${q(r.slug)}, ${q(r.slug)}, ${q(url(r.slug))}, 'POST',
    ${q(r.title)}, ${q(r.desc)}, ${q(r.bazaar)}, ${r.price}, ${arr(NET_CFG)},
    '${PAY_EVM}', '${PAY_SOL}', '${PAY_COS}', 'static', true, false, ${q(r.handler)}
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler, public_slug = EXCLUDED.public_slug,
        display_name = EXCLUDED.display_name, description = EXCLUDED.description,
        description_bazaar = EXCLUDED.description_bazaar, price_atomic = EXCLUDED.price_atomic,
        accepted_networks = EXCLUDED.accepted_networks, pay_to_evm = EXCLUDED.pay_to_evm,
        pay_to_solana = EXCLUDED.pay_to_solana, pay_to_cosmos = EXCLUDED.pay_to_cosmos,
        is_active = true, updated_at = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url, category, tags, price_atomic_min, price_atomic_max,
  price_unit, networks, status, resource_key_id, slug, sample_request_json,
  sample_response_json, description_bazaar, proxy_config_id
)
SELECT gen_random_uuid(), ${q(r.title)}, ${q(r.desc)}, ${q(url(r.slug))}, ${q(r.category)},
  ${arr(r.tags)}, ${r.price}, ${r.price}, 'per-call', ${arr(NET_CAT)}, 'approved',
  proxy_ins.resource_key_id, ${q(r.slug)}, ${jsn(r.sample)}, ${jsn(r.resp)}, ${q(r.bazaar)}, proxy_ins.id
FROM proxy_ins ON CONFLICT DO NOTHING;`);

writeFileSync(
  resolve(REPO, "scripts/seed/insert-batch-010.sql"),
  `-- GENERATED by gen-batch-010.mjs — 5 verdict products (batch-010).\n-- Idempotent UPSERT. Reuses reskey ${RESKEY} + active pool payTo.\nBEGIN;\n\n${blocks.join("\n\n")}\n\nCOMMIT;\n`,
);
writeFileSync(
  resolve(REPO, "scripts/pipeline/manifest-batch-010.json"),
  JSON.stringify(rows.map((r) => ({ slug: r.slug, priceUsdc: (r.price / 1e6).toFixed(6), category: r.category, sampleRequest: r.sample })), null, 2),
);
console.log(`OK: ${rows.length} endpoints -> insert-batch-010.sql + manifest-batch-010.json (payTo ${PAY_EVM})`);
