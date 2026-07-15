-- road-conditions — corridor weather + work-zone verdict ($0.25).
-- Idempotent UPSERT. Reuses reskey reskey_1166628d + active pool payTo (payto-005).
BEGIN;

WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug, original_url, original_method,
    display_name, description, description_bazaar, price_atomic, accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos, forward_auth_scheme, is_active,
    upstream_x402_enabled, internal_handler
  ) VALUES (
    gen_random_uuid(), 'reskey_1166628d', 'road-conditions', 'road-conditions', 'https://proxy.suverse.io/v1/data/road-conditions', 'POST',
    'Road Conditions (US corridor)',
    'POST an origin and destination ("lat,lon" or a US place name) and get one CLEAR / CAUTION / SEVERE verdict for the corridor between them: active National Weather Service alerts sampled every ~120 km along a great-circle corridor (deduped, severity-ranked - blizzard/ice/tornado/high-wind warnings and any Extreme alert drive SEVERE), plus WZDx work-zone events within 30 km from every state DOT that publishes a keyless feed, full closures first. Coverage is honest by construction: the response lists which crossed states have a live work-zone feed, which do not, and which feeds failed on this read - nothing is silently faked. Geocoding and NWS reachability are proven before your payment settles; if corridor weather coverage degrades below half after payment the call auto-refunds. Zone-scale conditions on a straight-line corridor, not turn-by-turn routing.',
    'CLEAR / CAUTION / SEVERE verdict for any US freight corridor: live NWS alerts sampled along the route + WZDx work zones within 30 km (closures first) from keyless state DOT feeds. Honest per-state coverage disclosure. Origin/destination as lat,lon or place names. Fail-closed, auto-refund.',
    250000, ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0xe90316121189715CDc2515B7C2673658b810b751', 'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM', 'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj', 'static', true, false, 'road_conditions'
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
SELECT gen_random_uuid(), 'Road Conditions (US corridor)',
  'POST an origin and destination ("lat,lon" or a US place name) and get one CLEAR / CAUTION / SEVERE verdict for the corridor between them: active National Weather Service alerts sampled every ~120 km along a great-circle corridor (deduped, severity-ranked - blizzard/ice/tornado/high-wind warnings and any Extreme alert drive SEVERE), plus WZDx work-zone events within 30 km from every state DOT that publishes a keyless feed, full closures first. Coverage is honest by construction: the response lists which crossed states have a live work-zone feed, which do not, and which feeds failed on this read - nothing is silently faked. Geocoding and NWS reachability are proven before your payment settles; if corridor weather coverage degrades below half after payment the call auto-refunds. Zone-scale conditions on a straight-line corridor, not turn-by-turn routing.',
  'https://proxy.suverse.io/v1/data/road-conditions', 'freight',
  ARRAY['freight','trucking','road-conditions','weather','nws','work-zones','wzdx','routing','verdict'], 250000, 250000, 'per-call', ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'], 'approved',
  proxy_ins.resource_key_id, 'road-conditions',
  '{"origin":"Chicago, IL","destination":"Atlanta, GA"}',
  '{"route":{"origin":{"input":"Chicago, IL","lat":41.8781,"lon":-87.6298},"destination":{"input":"Atlanta, GA","lat":33.749,"lon":-84.388},"distance_km":944,"corridor_sample_points":9,"states_crossed":["IL","IN","KY","TN","GA"]},"verdict":{"status":"CAUTION","flags":["weather_advisories_on_corridor","lane_closure_work_zones_on_corridor"],"confidence":"medium","summary":"Chicago -> Atlanta (944 km): CAUTION. 3 active NWS alerts on the corridor (Heat Advisory); 12 work zones within 30 km including 0 full closures."},"weather":{"active_alerts":[{"event":"Heat Advisory","severity":"Moderate","area":"Cook County"}],"total_alerts":3,"counts_by_severity":{"extreme":0,"severe":0,"moderate":3,"minor":0}},"work_zones":{"total_on_corridor":12,"all_lanes_closed":0,"some_lanes_closed":4,"corridor_buffer_km":30,"events":[{"road_names":["I-65"],"vehicle_impact":"some-lanes-closed","state":"indiana","distance_from_corridor_km":1.2}]},"coverage":{"nws":"nationwide; 9/9 corridor samples reachable","wzdx":{"states_crossed":["illinois","indiana","kentucky","tennessee","georgia"],"states_with_live_feed":["indiana","kentucky"],"states_without_public_feed":["illinois","tennessee","georgia"],"feeds_failed_this_read":[]}},"data_quality":{"stale_sources":[],"computed_at":"2026-07-15T21:00:00Z"}}',
  'CLEAR / CAUTION / SEVERE verdict for any US freight corridor: live NWS alerts sampled along the route + WZDx work zones within 30 km (closures first) from keyless state DOT feeds. Honest per-state coverage disclosure. Origin/destination as lat,lon or place names. Fail-closed, auto-refund.',
  proxy_ins.id
FROM proxy_ins ON CONFLICT DO NOTHING;

COMMIT;
