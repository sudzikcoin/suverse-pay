-- carrier-risk-verdict — freight vetting flagship ($0.75).
-- Idempotent UPSERT. Reuses reskey reskey_1166628d + active pool payTo (payto-005).
BEGIN;

WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug, original_url, original_method,
    display_name, description, description_bazaar, price_atomic, accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos, forward_auth_scheme, is_active,
    upstream_x402_enabled, internal_handler
  ) VALUES (
    gen_random_uuid(), 'reskey_1166628d', 'carrier-risk-verdict', 'carrier-risk-verdict', 'https://proxy.suverse.io/v1/data/carrier-risk-verdict', 'POST',
    'Carrier Risk Verdict (FMCSA)',
    'POST a USDOT or MC number (or a carrier name - ambiguous names return a free candidate list before any payment settles) and get one HIRE / VERIFY / AVOID verdict for putting a load on that trucking company. Synthesized from public FMCSA data: operating-authority status and history (revocations, reinstatements, involuntary suspensions), BIPD/cargo insurance on file with insurer and coverage vs the required minimum, BOC-3 process agent, 24-month roadside inspection and out-of-service record vs national averages, and MCS-150 census fraud signals (stale biennial filings, fleet-size jumps, undeliverable addresses - the pattern behind carrier-identity fraud). Component scores and the raw evidence behind every flag are included. Drug/alcohol Clearinghouse status is employer-query-only and honestly excluded. Critical sources are health-proven before your payment settles; degraded sources are named in data_quality, never silently omitted. Post-settle failures are auto-refunded. Carries the FMCSA SMS disclaimer; this is a SuVerse-derived assessment, not an FMCSA safety rating or CSA score.',
    'HIRE / VERIFY / AVOID verdict for any US trucking carrier by DOT, MC or name: authority status + revocation history, insurance on file vs required, BOC-3, 24-month inspection/OOS record, MCS-150 fraud signals (stale filings, fleet jumps). Public FMCSA data, component scores, evidence included. Fail-closed, auto-refund.',
    750000, ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0xe90316121189715CDc2515B7C2673658b810b751', 'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM', 'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj', 'static', true, false, 'carrier_risk_verdict'
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
SELECT gen_random_uuid(), 'Carrier Risk Verdict (FMCSA)',
  'POST a USDOT or MC number (or a carrier name - ambiguous names return a free candidate list before any payment settles) and get one HIRE / VERIFY / AVOID verdict for putting a load on that trucking company. Synthesized from public FMCSA data: operating-authority status and history (revocations, reinstatements, involuntary suspensions), BIPD/cargo insurance on file with insurer and coverage vs the required minimum, BOC-3 process agent, 24-month roadside inspection and out-of-service record vs national averages, and MCS-150 census fraud signals (stale biennial filings, fleet-size jumps, undeliverable addresses - the pattern behind carrier-identity fraud). Component scores and the raw evidence behind every flag are included. Drug/alcohol Clearinghouse status is employer-query-only and honestly excluded. Critical sources are health-proven before your payment settles; degraded sources are named in data_quality, never silently omitted. Post-settle failures are auto-refunded. Carries the FMCSA SMS disclaimer; this is a SuVerse-derived assessment, not an FMCSA safety rating or CSA score.',
  'https://proxy.suverse.io/v1/data/carrier-risk-verdict', 'freight',
  ARRAY['freight','trucking','carrier-vetting','fmcsa','usdot','double-brokering','fraud','insurance','verdict'], 750000, 750000, 'per-call', ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'], 'approved',
  proxy_ins.resource_key_id, 'carrier-risk-verdict',
  '{"dot":"264184"}',
  '{"carrier":{"usdot":"264184","dockets":["MC133655"],"legal_name":"SCHNEIDER NATIONAL CARRIERS INC","physical_location":"GREEN BAY, WI","resolved_from":"dot"},"verdict":{"decision":"HIRE","score":93,"component_scores":{"authority":100,"insurance":100,"safety":85,"fraud_signals":100},"hard_fail":null,"confidence":"high","summary":"SCHNEIDER NATIONAL CARRIERS INC (USDOT 264184) scores 93/100 -> HIRE. Authority active for 39+ years; $5,000,000 BIPD on file; 3200 roadside inspections in 24 months. No caution flags raised by public FMCSA data."},"evidence":{"authority":{"first_granted":"1987-06-01","authority_age_days":14290,"suspension_orders":[]},"insurance":{"bipd_on_file_usd":5000000,"bipd_required_usd":750000,"filings_on_file":[]},"safety":{"window_months":24,"note":"Raw roadside inspection counts. NOT a CSA/SMS score."},"fraud_signals":{"mcs150_stale":false,"fleet_jump":null}},"data_quality":{"stale_sources":[],"excluded_fields":{"drug_alcohol_status":"employer-query-only"},"disclaimer":"..."}}',
  'HIRE / VERIFY / AVOID verdict for any US trucking carrier by DOT, MC or name: authority status + revocation history, insurance on file vs required, BOC-3, 24-month inspection/OOS record, MCS-150 fraud signals (stale filings, fleet jumps). Public FMCSA data, component scores, evidence included. Fail-closed, auto-refund.',
  proxy_ins.id
FROM proxy_ins ON CONFLICT DO NOTHING;

COMMIT;
