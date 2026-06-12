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
