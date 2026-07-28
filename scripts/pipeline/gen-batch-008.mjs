#!/usr/bin/env node
/**
 * gen-batch-008.mjs — emit seed SQL + index manifest for the 5 in-house
 * smart-money/wallet internal_handler endpoints (bucket A of the B-E
 * demand-map). These are NOT URL wraps — each row sets internal_handler
 * to a handler registered in registry.ts; the declarative wrap-batch
 * pipeline does not apply. Idempotent UPSERT, ASCII copy.
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
    slug: "smart-money-token-rankings", handler: "smart_money_token_rankings", price: 30000,
    category: "smart-money", tags: ["smart-money", "rankings", "tokens", "netflow", "solana", "base"],
    title: "Smart-Money Token Rankings",
    desc: "Tokens ranked by aggregate smart-money score over the trailing 30 days, from our own smart-money-tracker netflow cache. Each row carries buy/sell/net USD flow, unique smart traders, smart-money score and momentum rank, with symbol decoration. Pass chain (base or solana, default solana) and limit (1-100).",
    bazaar: "Tokens ranked by smart-money score (30d) from our tracker: buy/sell/net USD flow, unique smart traders, smart-money score, momentum rank, symbol. chain=base|solana, limit<=100. In-house data, not a third-party proxy.",
    sample: { chain: "solana", limit: 20 },
    resp: { kind: "rankings", chain: "solana", time_window: "30d", count: 1, tokens: [{ token: "GaPb...pump", symbol: "EXAMPLE", net_flow_usd: 12500.0, unique_traders: 14, smart_money_score: 88.3, momentum_rank: 1 }], data_quality: { computed_at: "2026-06-21T22:36:06.000Z", stale: false, row_count: 1 } },
  },
  {
    slug: "smart-money-accumulation", handler: "smart_money_accumulation", price: 30000,
    category: "smart-money", tags: ["smart-money", "accumulation", "inflow", "tokens", "solana", "base"],
    title: "Smart-Money Accumulation",
    desc: "Tokens being accumulated by smart money: the largest POSITIVE smart-money net USD inflow over the trailing 30 days, from our tracker netflow cache. Buy/sell/net flow, unique smart traders, smart-money score per token, symbol decoration. Pass chain (base or solana) and limit.",
    bazaar: "Tokens with the biggest smart-money net INFLOW (30d) from our tracker: buy/sell/net USD, unique traders, smart-money score, symbol. chain=base|solana, limit<=100. In-house data.",
    sample: { chain: "solana", limit: 20 },
    resp: { kind: "accumulation", chain: "solana", time_window: "30d", count: 1, tokens: [{ token: "So111...", symbol: "EXAMPLE", net_flow_usd: 50000.0, unique_traders: 22, smart_money_score: 71.0 }], data_quality: { computed_at: "2026-06-21T22:36:06.000Z", stale: false, row_count: 1 } },
  },
  {
    slug: "smart-money-distribution", handler: "smart_money_distribution", price: 30000,
    category: "smart-money", tags: ["smart-money", "distribution", "outflow", "tokens", "solana", "base"],
    title: "Smart-Money Distribution",
    desc: "Tokens being distributed (sold) by smart money: the largest NEGATIVE smart-money net USD flow over the trailing 30 days, from our tracker netflow cache. Buy/sell/net flow, unique smart traders, smart-money score per token, symbol decoration. Pass chain (base or solana) and limit.",
    bazaar: "Tokens with the biggest smart-money net OUTFLOW (30d) from our tracker: buy/sell/net USD, unique traders, smart-money score, symbol. chain=base|solana, limit<=100. In-house data.",
    sample: { chain: "solana", limit: 20 },
    resp: { kind: "distribution", chain: "solana", time_window: "30d", count: 1, tokens: [{ token: "Dob5...", symbol: "EXAMPLE", net_flow_usd: -31500.0, unique_traders: 9, smart_money_score: 40.0 }], data_quality: { computed_at: "2026-06-21T22:36:06.000Z", stale: false, row_count: 1 } },
  },
  {
    slug: "smart-money-top-wallets", handler: "smart_money_top_wallets", price: 50000,
    category: "smart-money", tags: ["smart-money", "leaderboard", "wallets", "copy-trading", "pnl", "solana"],
    title: "Smart-Money Top Wallets",
    desc: "The smart-money wallet leaderboard: eligible wallets (hybrid gate: skill score >=60, confidence >=50, not quarantined) ranked by score then trailing 90-day PnL, from our smart-money-tracker scoring table. Each row carries address, tier, score, win rate, 90d PnL, realized PnL, profit factor, trade count, median holding time. Pass chain (base or solana) and limit.",
    bazaar: "Smart-money wallet leaderboard from our tracker: eligible wallets ranked by skill score then 90d PnL. address, tier, score, win rate, 90d/realized PnL, profit factor, holding time. chain=base|solana. In-house scoring data.",
    sample: { chain: "solana", limit: 20 },
    resp: { kind: "top_wallets", chain: "solana", count: 1, wallets: [{ address: "Dkc...P67Z", tier: "elite", score: 93.3, win_rate: 0.71, pnl_90d_usd: 26553.0, profit_factor: 3.1, trade_count_90d: 42 }], data_quality: { computed_at: "2026-06-20T21:32:08.000Z", stale: false, row_count: 1 } },
  },
  {
    slug: "wallet-label-lookup", handler: "wallet_label_lookup", price: 20000,
    category: "wallet-analytics", tags: ["wallet", "label", "entity", "market-maker", "cex", "deployer", "evm", "solana"],
    title: "Wallet Entity Label",
    desc: "Entity label for any wallet from our heuristic-labeling table: is it a contract, a CEX deposit address, a market maker, a token deployer, an LP actor or a probable bot, with the supporting evidence and confidence. Accepts an EVM (0x+40hex) or Solana base58 address; chain auto-detected. An unlabeled address returns labeled:false (absence is information), never an error.",
    bazaar: "Entity label for any wallet from our labeler: contract / CEX-deposit / market-maker / deployer / LP-actor / probable-bot, with evidence + confidence. EVM or Solana address, chain auto-detected. In-house heuristic labels.",
    sample: { address: "0x4446adc0b8136ffc55ddb7a488ba5509ace2a5ef" },
    resp: { address: "0x4446adc0b8136ffc55ddb7a488ba5509ace2a5ef", chain: "base", labeled: true, summary: "Labeled as: market_maker (confidence high).", labels: ["market_maker"], flags: { is_contract: false, is_cex_deposit: false, is_market_maker: true, is_deployer: false, is_lp_actor: false, is_probable_bot: false }, source_confidence: "high", last_observed_at: "2026-06-21T15:32:14.000Z" },
  },
];

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const arr = (a) => `ARRAY[${a.map(q).join(",")}]`;
const jsn = (o) => q(JSON.stringify(o));
const url = (slug) => `https://proxy.suverse.io/v1/data/${slug}`;

const blocks = rows.map((r) => `-- ${r.slug} (internal_handler=${r.handler}, $${(r.price / 1e6).toFixed(3)})
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
  resolve(REPO, "scripts/seed/insert-batch-008.sql"),
  `-- GENERATED by gen-batch-008.mjs — ${rows.length} in-house internal_handler endpoints.\n-- Idempotent UPSERT. Reuses reskey ${RESKEY} + active pool payTo.\nBEGIN;\n\n${blocks.join("\n\n")}\n\nCOMMIT;\n`,
);
writeFileSync(
  resolve(REPO, "scripts/pipeline/manifest-batch-008.json"),
  JSON.stringify(rows.map((r) => ({ slug: r.slug, priceUsdc: (r.price / 1e6).toFixed(6), category: r.category, sampleRequest: r.sample })), null, 2),
);
console.log(`OK: ${rows.length} endpoints -> insert-batch-008.sql + manifest-batch-008.json (payTo ${PAY_EVM})`);
