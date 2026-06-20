-- attach_input_schemas.sql — Task 57 follow-up (2026-06-12).
--
-- Per-config input schemas (migration 037) for every plain-proxy POST
-- config + cosmos-wallet-balance. Applied to prod 2026-06-12; kept
-- here as the durable record and for re-runs (idempotent UPDATEs —
-- safe to re-apply after a config re-seed).
--
-- Each schema is an exact mirror of the upstream's zod validation, so
-- the gate never rejects a body the upstream would accept:
--   smart-money-*        → smart-money-tracker/api/src/route.ts
--   polymarket-*         → polymarket-smart-money/api/src/routes/*.ts
--   cosmos-wallet-balance → apps/proxy/src/handlers/cosmos-wallet-balance.ts
--     (bech32 prefix set = chains in cosmos-chain-registry.ts)
--
-- All fields are optional on the netflow/polymarket endpoints ({} is
-- valid upstream — defaults apply; unknown fields are stripped
-- upstream, so they are deliberately NOT declared here). The
-- "integer" type and minimum/maximum bounds require the proxy build
-- to include commit dc1b71f — restart the proxy onto a new build
-- BEFORE applying schemas that use dialect features the running
-- process does not know, or every value of that field 422s.

UPDATE seller_proxy_configs SET input_schema = '{
  "type": "object", "required": [],
  "properties": {
    "chain": {"type": "string", "enum": ["solana", "base", "cosmos"], "description": "Chain to query (default solana)"},
    "time_window": {"type": "string", "enum": ["1h", "24h", "7d", "30d"], "description": "Lookback window (default 24h)"},
    "limit": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Max tokens returned (default 20)"}
  }
}'::jsonb WHERE endpoint_slug = 'smart-money-netflow' AND internal_handler IS NULL;

UPDATE seller_proxy_configs SET input_schema = '{
  "type": "object", "required": [],
  "properties": {
    "time_window": {"type": "string", "enum": ["1h", "24h", "7d", "30d"], "description": "Lookback window (default 24h)"},
    "limit": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Max tokens returned (default 20)"}
  }
}'::jsonb WHERE endpoint_slug IN ('smart-money-base', 'smart-money-cosmos') AND internal_handler IS NULL;

UPDATE seller_proxy_configs SET input_schema = '{
  "type": "object", "required": [],
  "properties": {
    "category": {"type": "string", "enum": ["politics", "crypto", "sports", "macro", "other", "all"], "description": "Market category filter (default all)"},
    "time_window": {"type": "string", "enum": ["1h", "24h", "7d", "30d"], "description": "Lookback window (default 24h)"},
    "min_smart_traders": {"type": "integer", "minimum": 0, "maximum": 50, "description": "Min distinct smart traders per market (default 3)"},
    "limit": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Max markets returned (default 20)"}
  }
}'::jsonb WHERE endpoint_slug = 'polymarket-smart-bias' AND internal_handler IS NULL;

UPDATE seller_proxy_configs SET input_schema = '{
  "type": "object", "required": [],
  "properties": {
    "time_window": {"type": "string", "enum": ["1h", "6h", "24h"], "description": "Lookback window (default 24h)"},
    "min_entry_size_usd": {"type": "number", "minimum": 100, "maximum": 100000, "description": "Min entry size in USD (default 5000)"},
    "category": {"type": "string", "enum": ["politics", "crypto", "sports", "macro", "other", "all"], "description": "Market category filter (default all)"},
    "limit": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Max entries returned (default 50)"}
  }
}'::jsonb WHERE endpoint_slug = 'polymarket-whale-entries' AND internal_handler IS NULL;

UPDATE seller_proxy_configs SET input_schema = '{
  "type": "object", "required": [],
  "properties": {
    "category": {"type": "string", "enum": ["politics", "crypto", "sports", "macro", "other", "overall"], "description": "Skill category (default overall)"},
    "min_resolved_markets": {"type": "integer", "minimum": 0, "maximum": 1000, "description": "Min resolved markets per trader (hard floor 20 applies server-side)"},
    "sort_by": {"type": "string", "enum": ["overall_score", "category_score", "events_count"], "description": "Ranking order (default overall_score)"},
    "limit": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Max traders returned (default 100)"}
  }
}'::jsonb WHERE endpoint_slug = 'polymarket-trader-skill' AND internal_handler IS NULL;

UPDATE seller_proxy_configs SET input_schema = '{
  "type": "object", "required": [],
  "properties": {
    "category": {"type": "string", "enum": ["politics", "crypto", "sports", "macro", "other", "all"], "description": "Market category filter (default all)"},
    "min_skilled_holders": {"type": "integer", "minimum": 1, "maximum": 50, "description": "Min skilled holders per market (default 3)"},
    "min_total_position_usd": {"type": "number", "minimum": 100, "maximum": 1000000, "description": "Min aggregate position in USD (default 1000)"},
    "sort_by": {"type": "string", "enum": ["conviction", "total_value", "largest_position"], "description": "Ranking order (default conviction)"},
    "limit": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Max markets returned (default 20)"}
  }
}'::jsonb WHERE endpoint_slug = 'polymarket-position-holders' AND internal_handler IS NULL;

-- cosmos-wallet-balance is an internal-handler config with no in-code
-- validator; `address` is genuinely required (bech32, chain detected
-- from the prefix). Empty/placeholder bodies still get the 402
-- discovery challenge; paid-empty and present-but-invalid 422.
UPDATE seller_proxy_configs SET input_schema = '{
  "type": "object", "required": ["address"],
  "properties": {
    "address": {"type": "string", "pattern": "^(cosmos|noble|osmo|juno|stride)1[a-z0-9]{38,58}$", "description": "bech32 Cosmos-ecosystem address; the chain is detected from the prefix"}
  }
}'::jsonb WHERE endpoint_slug = 'cosmos-wallet-balance';

-- ── Round 2 (2026-06-12 evening) — the configs the crawler 0x9CC42f
-- and new buyer 0xfEe7578f paid 4xx on during their Jun 12 sweeps.
-- All six are internal-handler configs WITHOUT registered validators;
-- schemas mirror the handlers' own parsing exactly (handlers/*.ts),
-- so paid garbage now stops pre-settle instead of charging for a 400.

UPDATE seller_proxy_configs SET input_schema = '{
  "type": "object", "required": ["address"],
  "properties": {
    "address": {"type": "string", "pattern": "^0x[0-9a-fA-F]{40}$", "description": "EVM address on Base"},
    "limit": {"type": "integer", "minimum": 1, "maximum": 50, "description": "Max transactions returned (default 20)"}
  }
}'::jsonb WHERE internal_handler = 'blockscout_base_wallet_history';

UPDATE seller_proxy_configs SET input_schema = '{
  "type": "object", "required": ["contract_address"],
  "properties": {
    "contract_address": {"type": "string", "pattern": "^0x[0-9a-fA-F]{40}$", "description": "Contract address on Base"}
  }
}'::jsonb WHERE internal_handler IN ('etherscan_base_contract_info', 'blockscout_base_token_holders');

UPDATE seller_proxy_configs SET input_schema = '{
  "type": "object", "required": ["tx_hash"],
  "properties": {
    "tx_hash": {"type": "string", "pattern": "^0x[0-9a-fA-F]{64}$", "description": "Base transaction hash"}
  }
}'::jsonb WHERE internal_handler = 'base_rpc_tx_decoder';

UPDATE seller_proxy_configs SET input_schema = '{
  "type": "object", "required": ["address"],
  "properties": {
    "address": {"type": "string", "minLength": 25, "maxLength": 90, "description": "Bitcoin address (legacy, P2SH, bech32)"}
  }
}'::jsonb WHERE internal_handler = 'bitcoin_address_info';

-- days has NO maximum on purpose: the handler clamps >365 to 365
-- rather than rejecting, and the schema must never 422 a body the
-- handler would accept.
UPDATE seller_proxy_configs SET input_schema = '{
  "type": "object", "required": ["coin_id"],
  "properties": {
    "coin_id": {"type": "string", "pattern": "^[a-z0-9-]{1,80}$", "description": "CoinGecko coin id, e.g. bitcoin"},
    "days": {"type": "integer", "minimum": 1, "description": "Lookback days 1-365 (default 30; values above 365 are clamped)"}
  }
}'::jsonb WHERE internal_handler = 'coingecko_ohlc_history';

-- ============================================================
-- 2026-06-20: Round 3 — backfill 24 ungated bespoke internal-handler
--   POST endpoints that had NO input_schema and NO registered preflight.
--   Root cause of a systemic settled-then-4xx leak (165 calls / $5.57
--   all-time): AI agents brute-forcing param shapes paid per wrong guess.
--   Scope = REQUIRED-field handlers only (all-optional ones excluded to
--   avoid 422'ing legit empty-body paid calls). Enums/case-sensitive
--   patterns on semantic string fields dropped to avoid false rejects.
-- ============================================================
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["date","symbol"],"properties":{"date":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}$","description":"ISO date YYYY-MM-DD. Required. Must be >= 1999-01-04 and not in the future."},"symbol":{"type":"string","pattern":"^[A-Za-z]{3}$","description":"3-letter target currency code (case-insensitive). Required."},"base":{"type":"string","pattern":"^[A-Za-z]{3}$","description":"3-letter base currency code (case-insensitive). Optional, defaults to USD."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$frankfurter_historical$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["symbols"],"properties":{"symbols":{"type":"array","description":"Array of 1-30 three-letter currency codes (case-insensitive). Required, non-empty."},"base":{"type":"string","pattern":"^[A-Za-z]{3}$","description":"3-letter base currency code (case-insensitive). Optional, defaults to USD."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$frankfurter_rates_batch$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["contract_address"],"properties":{"contract_address":{"type":"string","pattern":"^0x[0-9a-fA-F]{40}$","description":"Base ERC-20 contract address (0x + 40 hex). Required."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$goplus_token_risk_base$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["txid"],"properties":{"txid":{"type":"string","pattern":"^[0-9a-fA-F]{64}$","minLength":64,"maxLength":64,"description":"64-character hex Bitcoin transaction id to decode. Required."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$bitcoin_tx_decoder$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":[],"properties":{"height":{"type":"integer","minimum":0,"description":"Block height to look up. Supply exactly one of height or hash."},"hash":{"type":"string","pattern":"^[0-9a-fA-F]{64}$","minLength":64,"maxLength":64,"description":"64-char hex block hash. Supply exactly one of height or hash."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$bitcoin_block_info$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["ticker"],"properties":{"ticker":{"type":"string","pattern":"^[A-Za-z0-9.\\-]{1,12}$","minLength":1,"maxLength":12,"description":"Stock ticker (1-12 chars alphanumeric plus dot/dash), case-insensitive; resolved to a SEC CIK. Required."},"limit":{"type":"integer","minimum":1,"maximum":100,"description":"Max recent filings to return. Optional; default 20, capped at 100."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$sec_filings$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["chain"],"properties":{"chain":{"type":"string","description":"Cosmos chain slug (case-insensitive); must resolve in the chain registry. Required."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$cosmos_chain_info$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["chain","tx_hash"],"properties":{"chain":{"type":"string","description":"Source Cosmos chain slug (case-insensitive); must resolve in registry. Required."},"tx_hash":{"type":"string","pattern":"^[0-9a-fA-F]{64}$","minLength":64,"maxLength":64,"description":"64-char hex transaction hash (case-insensitive). Required."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$cosmos_ibc_tracker$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["chain","tx_hash"],"properties":{"chain":{"type":"string","description":"Cosmos chain slug (case-insensitive); must resolve in registry. Required."},"tx_hash":{"type":"string","pattern":"^[0-9a-fA-F]{64}$","minLength":64,"maxLength":64,"description":"64-char hex transaction hash (case-insensitive). Required."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$cosmos_tx_decoder$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["chain","validator"],"properties":{"chain":{"type":"string","description":"Cosmos chain slug (case-insensitive); must resolve in registry. Required."},"validator":{"type":"string","description":"Bech32 valoper address; prefix must match the chain (e.g. cosmosvaloper1...). Required."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$cosmos_validator_stats$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["mint"],"properties":{"mint":{"type":"string","minLength":32,"maxLength":44,"description":"Solana mint address (base58, 32-44 chars) of the NFT/cNFT asset. Required."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$helius_nft_metadata$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["signature"],"properties":{"signature":{"type":"string","minLength":64,"maxLength":128,"pattern":"^[1-9A-HJ-NP-Za-km-z]+$","description":"Solana transaction signature (base58, 64-128 chars). Required."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$helius_tx_decoder$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["transaction"],"properties":{"transaction":{"type":"string","minLength":100,"pattern":"^[A-Za-z0-9+/]+=*$","description":"Base64-encoded Solana transaction wire blob to dry-run (min 100 chars). Required."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$helius_tx_simulator$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["address"],"properties":{"address":{"type":"string","minLength":32,"maxLength":44,"description":"Solana wallet address (base58, 32-44 chars). Required."},"limit":{"type":"integer","minimum":1,"description":"Max transactions to return (default 10, capped at 100). Optional."},"before":{"type":"string","description":"Pagination cursor: signature of the last tx in the previous page. Optional."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$helius_wallet_history$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["ids"],"properties":{"ids":{"type":"array","description":"Array of 1-50 CoinGecko coin-id strings (e.g. bitcoin, ethereum). Required, non-empty."},"vs_currency":{"type":"string","description":"Quote currency, lowercased. Optional; default usd."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$coingecko_price_batch$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["protocol"],"properties":{"protocol":{"type":"string","minLength":1,"maxLength":80,"description":"DeFiLlama protocol slug, lowercase kebab-case (e.g. aave-v3). Required."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$defillama_protocol_tvl$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["symbol"],"properties":{"symbol":{"type":"string","pattern":"^[A-Za-z0-9]{2,20}$","description":"Binance perp symbol (e.g. BTCUSDT). Required."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$binance_funding$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["symbols"],"properties":{"symbols":{"type":"array","description":"Array of 1-50 Binance perp symbols. Required, non-empty."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$binance_funding_batch$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["symbol"],"properties":{"symbol":{"type":"string","pattern":"^[A-Za-z0-9]{2,20}$","description":"Binance futures symbol (e.g. BTCUSDT). Required."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$binance_open_interest$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["symbol"],"properties":{"symbol":{"type":"string","pattern":"^[A-Za-z0-9]{2,20}$","description":"Binance spot symbol (e.g. BTCUSDT). Required."},"limit":{"type":"integer","minimum":1,"description":"Book levels per side; optional, default 50, capped at 100."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$binance_orderbook$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["symbol"],"properties":{"symbol":{"type":"string","pattern":"^[A-Za-z0-9]{2,20}$","description":"Binance spot symbol (e.g. BTCUSDT). Required."},"limit":{"type":"integer","minimum":1,"description":"Recent trades count; optional, default 100, capped at 1000."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$binance_trades$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["symbol"],"properties":{"symbol":{"type":"string","pattern":"^[A-Za-z0-9]{2,20}$","description":"Binance spot symbol (e.g. BTCUSDT). Required."},"interval":{"type":"string","description":"Kline interval (e.g. 1h, 1d). Optional, default 1h."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$ta_macd$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["symbol"],"properties":{"symbol":{"type":"string","pattern":"^[A-Za-z0-9]{2,20}$","description":"Binance spot symbol (e.g. BTCUSDT). Required."},"interval":{"type":"string","description":"Kline interval (e.g. 1h, 1d). Optional, default 1d."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$ta_moving_averages$h$ AND original_method='POST';
UPDATE seller_proxy_configs SET input_schema = $SCHEMA${"type":"object","required":["symbol"],"properties":{"symbol":{"type":"string","pattern":"^[A-Za-z0-9]{2,20}$","description":"Binance spot symbol (e.g. BTCUSDT). Required."},"interval":{"type":"string","description":"Kline interval (e.g. 1h, 1d). Optional, default 1h."},"period":{"type":"integer","minimum":2,"maximum":200,"description":"RSI lookback period; optional, default 14. Integer 2-200."}}}$SCHEMA$::jsonb, updated_at=now() WHERE internal_handler = $h$ta_rsi$h$ AND original_method='POST';
