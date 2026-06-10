-- Seed: wallet-reputation — ONE aggregated $0.03 endpoint answering
-- "can this Solana wallet's trading be trusted / is it worth copying?"
-- from internal sources only: the smart-money-tracker scoring table
-- (sm_wallets, ~11k wallets, hybrid eligibility gate), the wallet's
-- indexed trade history (sm_trades), and optional Helius Enhanced
-- Transactions decoration (degrades gracefully).
--
-- Handler: internal_handler='wallet_reputation' (apps/proxy
-- handlers/wallet-reputation.ts). Fail-closed: a registered preflight
-- proves sm_wallets + sm_trades BEFORE settlement, so buyers are never
-- charged for an uncomputable verdict. A base58 validator rejects
-- garbage wallets with 422 before the 402 challenge.
--
-- Idempotent — re-runs safe via UPSERT. Descriptions ASCII-only.

BEGIN;

WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, description_bazaar, price_atomic,
    accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos,
    forward_auth_scheme, is_active, upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'wallet-reputation', 'wallet-reputation',
    'https://proxy.suverse.io/v1/data/wallet-reputation',
    'POST',
    'Solana Wallet Reputation',
    'One aggregated reputation verdict for any Solana wallet address in a single paid call: skill tier (elite, skilled, average, weak, unknown) derived from our smart-money scoring system tracking thousands of wallets, activity classification (active, dormant, occasional), trading style flags (high_frequency, large_size, diversified, concentrated), full trade statistics over 24h, 7 days and 30 days windows with volume and distinct tokens, up to 10 recent classified trades, and optional recent on-chain activity decoration. Answers whether a wallet trading record can be trusted or copied, using only on-chain trading data. Returns verdict, per-source signals, data quality block, and raw source data.',
    'Solana wallet reputation verdict in one call: smart-money skill tier (elite, skilled, average, weak, unknown), activity class, trading style flags, 24h/7d/30d trade stats, recent classified trades. Answers: can this wallet trading be trusted or copied? On-chain data only.',
    30000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static', true, false,
    'wallet_reputation'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug = EXCLUDED.public_slug, display_name = EXCLUDED.display_name,
        description = EXCLUDED.description,
        description_bazaar = EXCLUDED.description_bazaar,
        price_atomic = EXCLUDED.price_atomic,
        accepted_networks = EXCLUDED.accepted_networks,
        pay_to_evm = EXCLUDED.pay_to_evm, pay_to_solana = EXCLUDED.pay_to_solana,
        pay_to_cosmos = EXCLUDED.pay_to_cosmos, updated_at = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url, category, tags,
  price_atomic_min, price_atomic_max, price_unit, networks, status,
  resource_key_id, slug, sample_request_json, sample_response_json, proxy_config_id
)
SELECT
  gen_random_uuid(),
  'Solana Wallet Reputation',
  'One aggregated reputation verdict for any Solana wallet address in a single paid call: skill tier (elite, skilled, average, weak, unknown) derived from our smart-money scoring system, activity classification, trading style flags, full 24h/7d/30d trade statistics, up to 10 recent classified trades, and optional recent on-chain activity decoration. Answers whether a wallet trading record can be trusted or copied, using only on-chain trading data.',
  'https://proxy.suverse.io/v1/data/wallet-reputation',
  'smart-money',
  ARRAY['solana','wallet','reputation','smart-money','copy-trading','trader-skill','aggregated','verdict'],
  30000, 30000, 'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved', proxy_ins.resource_key_id, 'wallet-reputation',
  '{"wallet":"CBjwziSG9Z48MSAfqXNuKHyQ3JqrC963pNeivoUSAV5b"}',
  '{"wallet":"CBjwziSG9Z48MSAfqXNuKHyQ3JqrC963pNeivoUSAV5b","verdict":{"tier":"elite","score":92.81,"activity":"active","summary":"This wallet scores 92.81/100 and currently passes our smart-money eligibility filter, placing it in the elite tier of tracked wallets. It is active, with 18 trades in the last 30 days (about $14250.00 across 11 distinct tokens), last trade 2026-06-08. Trading style: diversified.","confidence":"high"},"signals":{"scoring":{"score":92.81,"eligible":true,"score_version":"v1","last_scored_at":"2026-06-06T01:10:00.000Z"},"trading":{"trade_count_24h":2,"trade_count_7d":9,"trade_count_30d":18,"volume_usd_30d":14250.0,"distinct_tokens_30d":11,"avg_trade_size_usd":791.67,"first_seen":"2026-01-12T08:30:00.000Z","last_trade_at":"2026-06-08T19:12:00.000Z"},"style":["diversified"],"recent_activity":[{"token":"BONK","side":"buy","usd":420.5,"timestamp":"2026-06-08T19:12:00.000Z"}]},"data_quality":{"stale_sources":[],"computed_at":"2026-06-10T12:00:00.000Z","tracking_coverage":"tracked"},"raw":{"scoring_row":{"address":"CBjw...","score":92.81},"trade_aggregates":{"trade_count_30d":18},"helius_sample":[{"signature":"sig1","type":"SWAP"}]}}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

COMMIT;
