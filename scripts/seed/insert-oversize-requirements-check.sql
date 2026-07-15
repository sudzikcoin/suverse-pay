-- oversize-requirements-check — per-state OS/OW permit verdict ($0.50).
-- Idempotent UPSERT. Reuses reskey reskey_1166628d + active pool payTo (payto-005).
BEGIN;

WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug, original_url, original_method,
    display_name, description, description_bazaar, price_atomic, accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos, forward_auth_scheme, is_active,
    upstream_x402_enabled, internal_handler
  ) VALUES (
    gen_random_uuid(), 'reskey_1166628d', 'oversize-requirements-check', 'oversize-requirements-check', 'https://proxy.suverse.io/v1/data/oversize-requirements-check', 'POST',
    'Oversize/Overweight Requirements Check (US)',
    'POST a load''s dimensions (width/height/length in feet+inches or decimal feet, gross weight in lbs, optional axle count) plus an origin and destination (place names or "lat,lon"), and get one LEGAL / PERMITS_REQUIRED / SUPERLOAD_REVIEW verdict for moving that oversize/overweight load, broken down per state crossed. Each state entry: whether a permit is required and which dimension triggered it, single-trip vs annual permit, the escort/pilot-car requirement (none / 1 pilot / 2 pilots / pole car / police as codified), movement/curfew restrictions, a fee estimate that ALWAYS carries a verify-with-state flag, whether a superload threshold is hit, plus the state permit-office source_url and rules_as_of date. Route states are derived from a great-circle corridor (planning-grade, not the state-assigned permitted route). Honesty is the product: this is informational planning data, NOT a permit and NOT legal advice; superloads are sent to engineering review rather than given a fake fee; states whose escort/fee specifics are not yet point-verified are flagged verify_with_state instead of guessed. State-level rules only in v1 - county/city permits, bridge engineering and low-clearance routing are out of scope and disclosed. Fail-closed before payment (dataset, geocoding and state resolution proven first); post-settle failures auto-refund.',
    'LEGAL / PERMITS_REQUIRED / SUPERLOAD_REVIEW verdict for an oversize/overweight truck load across every state on the US route. Per-state permit trigger, escort/pilot matrix, curfews, fee estimate (always verify-with-state), superload flag, source_url. Feet+inches or decimal input. State-level only. Fail-closed.',
    500000, ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0xe90316121189715CDc2515B7C2673658b810b751', 'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM', 'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj', 'static', true, false, 'oversize_requirements_check'
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
SELECT gen_random_uuid(), 'Oversize/Overweight Requirements Check (US)',
  'POST a load''s dimensions (width/height/length in feet+inches or decimal feet, gross weight in lbs, optional axle count) plus an origin and destination (place names or "lat,lon"), and get one LEGAL / PERMITS_REQUIRED / SUPERLOAD_REVIEW verdict for moving that oversize/overweight load, broken down per state crossed. Each state entry: whether a permit is required and which dimension triggered it, single-trip vs annual permit, the escort/pilot-car requirement (none / 1 pilot / 2 pilots / pole car / police as codified), movement/curfew restrictions, a fee estimate that ALWAYS carries a verify-with-state flag, whether a superload threshold is hit, plus the state permit-office source_url and rules_as_of date. Route states are derived from a great-circle corridor (planning-grade, not the state-assigned permitted route). Honesty is the product: this is informational planning data, NOT a permit and NOT legal advice; superloads are sent to engineering review rather than given a fake fee; states whose escort/fee specifics are not yet point-verified are flagged verify_with_state instead of guessed. State-level rules only in v1 - county/city permits, bridge engineering and low-clearance routing are out of scope and disclosed. Fail-closed before payment (dataset, geocoding and state resolution proven first); post-settle failures auto-refund.',
  'https://proxy.suverse.io/v1/data/oversize-requirements-check', 'freight',
  ARRAY['freight','trucking','oversize','overweight','osow','permits','escort','pilot-car','superload','verdict'], 500000, 500000, 'per-call', ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'], 'approved',
  proxy_ins.resource_key_id, 'oversize-requirements-check',
  '{"width_ft":12,"width_in":6,"height_ft":14.5,"length_ft":95,"gross_weight_lbs":145000,"axles":7,"origin":"Chicago, IL","destination":"Houston, TX"}',
  '{"load":{"width_ft":12.5,"height_ft":14.5,"length_ft":95,"gross_weight_lbs":145000,"axles":7},"route":{"origin":{"input":"Chicago, IL","resolved":"Chicago, Cook County, Illinois"},"destination":{"input":"Houston, TX","resolved":"Houston, Harris County, Texas"},"distance_miles":1082,"states_crossed":["IL","MO","AR","TX"]},"verdict":{"status":"PERMITS_REQUIRED","confidence":"medium","states_requiring_permits":["IL","MO","AR","TX"],"superload_states":[],"summary":"Chicago -> Houston (12.50''W x 14.50''H x 95''L, 145,000 lbs): PERMITS_REQUIRED. 4/4 states require permits (IL, MO, AR, TX); up to 1 pilot car required."},"states":[{"state":"TX","permit_required":true,"triggered_by":["width","height","weight"],"permit_type":"single-trip","escort_requirements":"1 pilot + pole car (height)","fee_estimate":{"usd_min":null,"usd_max":null,"formula":"Texas fees via TxDMV schedules; quote through TxPROS","verify_with_state":true},"superload_threshold_hit":false,"source_url":"https://www.txdmv.gov/motor-carriers/oversize-overweight-permits","rules_as_of":"2025-06-01","data_quality":"verify_with_state"}],"scope":{"state_level_only":true,"out_of_scope":["county and city permits","bridge-specific engineering restrictions","low-clearance routing","axle-group weight analysis"],"disclaimer":"Informational planning data, NOT a permit and NOT legal advice. Fees are estimates - always verify with the state permit office."},"data_quality":{"states_flagged_verify_with_state":[{"state":"TX","reasons":["knowledge-based escort matrix and fees pending point verification"]}],"oldest_rules_as_of":"2025-06-01","dataset":"in-repo data/oversize-rules"}}',
  'LEGAL / PERMITS_REQUIRED / SUPERLOAD_REVIEW verdict for an oversize/overweight truck load across every state on the US route. Per-state permit trigger, escort/pilot matrix, curfews, fee estimate (always verify-with-state), superload flag, source_url. Feet+inches or decimal input. State-level only. Fail-closed.',
  proxy_ins.id
FROM proxy_ins ON CONFLICT DO NOTHING;

COMMIT;
