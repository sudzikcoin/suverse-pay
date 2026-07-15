-- broker-authority-check — freight vetting sibling ($0.25).
-- Idempotent UPSERT. Reuses reskey reskey_1166628d + active pool payTo (payto-005).
BEGIN;

WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug, original_url, original_method,
    display_name, description, description_bazaar, price_atomic, accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos, forward_auth_scheme, is_active,
    upstream_x402_enabled, internal_handler
  ) VALUES (
    gen_random_uuid(), 'reskey_1166628d', 'broker-authority-check', 'broker-authority-check', 'https://proxy.suverse.io/v1/data/broker-authority-check', 'POST',
    'Broker Authority Check (FMCSA)',
    'POST a freight broker MC number (or USDOT as a convenience) and get one ACTIVE_BONDED / WATCH / REVOKED verdict on its FMCSA standing: broker operating-authority status and age, full authority event history (revocations, reinstatements, involuntary suspensions), the BMC-84 surety bond or BMC-85 trust fund on file with amount and insurer vs the $75,000 MAP-21 minimum, and the BOC-3 process agent. This is EXPLICITLY NOT a credit score: broker payment behavior (days-to-pay) lives in proprietary factoring-contributed data and cannot be derived from public sources - the response says so rather than pretending. Built on daily-refreshed FMCSA Motus registration extracts, fail-closed if the mirror is stale; unknown dockets are a free 404 before any payment settles. Post-settle failures are auto-refunded.',
    'ACTIVE_BONDED / WATCH / REVOKED verdict for any freight broker MC: FMCSA authority status + age, revocation/suspension history, $75k surety bond or trust fund on file with insurer, BOC-3 agent. Public FMCSA data, evidence included. Explicitly NOT a credit score. Fail-closed, auto-refund.',
    250000, ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0xe90316121189715CDc2515B7C2673658b810b751', 'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM', 'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj', 'static', true, false, 'broker_authority_check'
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
SELECT gen_random_uuid(), 'Broker Authority Check (FMCSA)',
  'POST a freight broker MC number (or USDOT as a convenience) and get one ACTIVE_BONDED / WATCH / REVOKED verdict on its FMCSA standing: broker operating-authority status and age, full authority event history (revocations, reinstatements, involuntary suspensions), the BMC-84 surety bond or BMC-85 trust fund on file with amount and insurer vs the $75,000 MAP-21 minimum, and the BOC-3 process agent. This is EXPLICITLY NOT a credit score: broker payment behavior (days-to-pay) lives in proprietary factoring-contributed data and cannot be derived from public sources - the response says so rather than pretending. Built on daily-refreshed FMCSA Motus registration extracts, fail-closed if the mirror is stale; unknown dockets are a free 404 before any payment settles. Post-settle failures are auto-refunded.',
  'https://proxy.suverse.io/v1/data/broker-authority-check', 'freight',
  ARRAY['freight','broker','fmcsa','authority','surety-bond','boc3','double-brokering','verdict'], 250000, 250000, 'per-call', ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'], 'approved',
  proxy_ins.resource_key_id, 'broker-authority-check',
  '{"mc":"MC-133655"}',
  '{"broker":{"docket":"MC133655","usdot":"264184","legal_name":"SCHNEIDER NATIONAL CARRIERS INC","physical_location":"GREEN BAY, WI","carrier_authority_also_active":true},"verdict":{"status":"ACTIVE_BONDED","flags":[],"confidence":"high","summary":"SCHNEIDER NATIONAL CARRIERS INC (MC133655) -> ACTIVE_BONDED: holds active FMCSA broker authority with financial responsibility on file. broker authority ~30y old; $75,000 surety bond (BMC-84) on file; BOC-3 on file. No flags raised by public FMCSA data."},"evidence":{"authority":{"broker_authority_active":true,"authority_age_days":11000,"revocation_events":0,"suspension_orders":[]},"financial_responsibility":{"on_file":true,"kind":"SURETY","amount_usd":75000,"required_usd":75000,"form":"BMC-84"},"boc3_process_agent":{"co_name":"..."}},"data_quality":{"not_a_credit_score":"This is an authority/bond/registration check only...","stale_sources":[]}}',
  'ACTIVE_BONDED / WATCH / REVOKED verdict for any freight broker MC: FMCSA authority status + age, revocation/suspension history, $75k surety bond or trust fund on file with insurer, BOC-3 agent. Public FMCSA data, evidence included. Explicitly NOT a credit score. Fail-closed, auto-refund.',
  proxy_ins.id
FROM proxy_ins ON CONFLICT DO NOTHING;

COMMIT;
