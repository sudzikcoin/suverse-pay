-- reefer-rate-report — USDA produce lane rates ($0.25).
-- Idempotent UPSERT. Reuses reskey reskey_1166628d + active pool payTo (payto-005).
BEGIN;

WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug, original_url, original_method,
    display_name, description, description_bazaar, price_atomic, accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos, forward_auth_scheme, is_active,
    upstream_x402_enabled, internal_handler
  ) VALUES (
    gen_random_uuid(), 'reskey_1166628d', 'reefer-rate-report', 'reefer-rate-report', 'https://proxy.suverse.io/v1/data/reefer-rate-report', 'POST',
    'Reefer Rate Report (USDA produce lanes)',
    'POST a produce shipping region (fuzzy-matched: "salinas", "kern district", "south texas", "yakima"...) and optionally a receiving metro, and get the current USDA weekly refrigerated truck rate verdict for that lane: spot rate range in USD per load (48-53ft reefer), truck availability (SURPLUS to SHORTAGE), week-over-week trend, the commodities the rate covers, and every other reported lane from that region. Source is the USDA AMS Specialty Crops National Truck Rate Report - the only legally free truckload lane-rate signal anywhere - refreshed weekly, public domain. Honest positioning: REEFER/PRODUCE LANES ONLY at region-to-metro granularity; this is NOT a general dry-van lane-rate product and does not pretend to be. Unknown regions or destinations return a free 422 carrying the full menu of what the report covers, so you never pay to learn the input space. Fail-closed if the stored report goes stale; post-settle failures auto-refund.',
    'USDA weekly reefer rate verdict for produce lanes: spot $/load range, truck availability (surplus-shortage), WoW trend, commodities - region to metro. The only legally free truckload lane-rate data. Produce/reefer only, honestly scoped. Free menu on unknown inputs. Fail-closed, auto-refund.',
    250000, ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0xe90316121189715CDc2515B7C2673658b810b751', 'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM', 'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj', 'static', true, false, 'reefer_rate_report'
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
SELECT gen_random_uuid(), 'Reefer Rate Report (USDA produce lanes)',
  'POST a produce shipping region (fuzzy-matched: "salinas", "kern district", "south texas", "yakima"...) and optionally a receiving metro, and get the current USDA weekly refrigerated truck rate verdict for that lane: spot rate range in USD per load (48-53ft reefer), truck availability (SURPLUS to SHORTAGE), week-over-week trend, the commodities the rate covers, and every other reported lane from that region. Source is the USDA AMS Specialty Crops National Truck Rate Report - the only legally free truckload lane-rate signal anywhere - refreshed weekly, public domain. Honest positioning: REEFER/PRODUCE LANES ONLY at region-to-metro granularity; this is NOT a general dry-van lane-rate product and does not pretend to be. Unknown regions or destinations return a free 422 carrying the full menu of what the report covers, so you never pay to learn the input space. Fail-closed if the stored report goes stale; post-settle failures auto-refund.',
  'https://proxy.suverse.io/v1/data/reefer-rate-report', 'freight',
  ARRAY['freight','reefer','produce','lane-rates','usda','truck-rates','spot-rates','verdict'], 250000, 250000, 'per-call', ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'], 'approved',
  proxy_ins.resource_key_id, 'reefer-rate-report',
  '{"origin":"salinas","destination":"Chicago"}',
  '{"lane":{"origin_region":"SALINAS-WATSONVILLE CALIFORNIA","destination":"Chicago","commodities_reported":["BROCCOLI","CAULIFLOWER","LETTUCE, ICEBERG","STRAWBERRIES"]},"verdict":{"truck_availability":"SLIGHT_SHORTAGE","rate_range_usd_per_load":[6300,6700],"mostly_usd_per_load":null,"trend_wow_pct":-4,"trend":"down","confidence":"high","summary":"SALINAS-WATSONVILLE CALIFORNIA -> Chicago: $6,300-$6,700 per reefer load, truck availability slight shortage, rates down -4% week-over-week (USDA report of 2026-07-14)."},"lanes":[{"destination":"Chicago","truck_availability":"SLIGHT_SHORTAGE","rate_low_usd":6300,"rate_high_usd":6700,"pct_change_wow":-4}],"data_quality":{"report_date":"2026-07-14","source":"USDA AMS Specialty Crops National Truck Rate Report (FVWTRK), public domain","scope":"Reefer/produce spot rates only, region->metro granularity, weekly. This is NOT a general dry-van lane-rate product."}}',
  'USDA weekly reefer rate verdict for produce lanes: spot $/load range, truck availability (surplus-shortage), WoW trend, commodities - region to metro. The only legally free truckload lane-rate data. Produce/reefer only, honestly scoped. Free menu on unknown inputs. Fail-closed, auto-refund.',
  proxy_ins.id
FROM proxy_ins ON CONFLICT DO NOTHING;

COMMIT;
