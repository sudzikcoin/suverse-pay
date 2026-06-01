-- Seed: SuVerse Solana Transaction Decoder (first-party Helius-backed
-- endpoint, no upstream x402). Idempotent — re-runs are safe.
--
-- Inserts:
--   * seller_proxy_configs row with internal_handler='helius_tx_decoder'.
--   * catalog_listings row (auto-approved) so CDP's bazaar crawler picks
--     it up and the 402 challenge carries extensions.bazaar.
--
-- All addresses + resource key match the existing live solana-tx-decoder
-- wrap. The two rows coexist; this one is the long-term replacement.

BEGIN;

WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug,
    original_url, original_method,
    display_name, description, price_atomic,
    accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos,
    forward_auth_scheme,
    is_active,
    upstream_x402_enabled,
    internal_handler
  ) VALUES (
    gen_random_uuid(),
    'reskey_1166628d',
    'suverse-solana-tx-decoder',
    'suverse-solana-tx-decoder',
    -- original_url is unused at runtime for internal handlers, but the
    -- column is NOT NULL. Point it at the canonical proxy URL so
    -- nothing surprising leaks into dashboards.
    'https://proxy.suverse.io/v1/data/suverse-solana-tx-decoder',
    'POST',
    'SuVerse Solana Transaction Decoder',
    'Decode any Solana transaction by signature into a structured human-readable summary. Returns invoked programs, token balance changes, fees in SOL and USD, instruction flow, and one-line summary. Powered by SuVerse infrastructure on top of Solana mainnet. Multi-network payment — pay with Base USDC, Solana USDC, or Cosmos USDC.',
    50000,
    ARRAY['eip155:8453','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','cosmos:noble-1'],
    '0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0',
    'CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM',
    'noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj',
    'static',
    true,
    false,
    'helius_tx_decoder'
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler,
        public_slug      = EXCLUDED.public_slug,
        display_name     = EXCLUDED.display_name,
        description      = EXCLUDED.description,
        price_atomic     = EXCLUDED.price_atomic,
        accepted_networks= EXCLUDED.accepted_networks,
        pay_to_evm       = EXCLUDED.pay_to_evm,
        pay_to_solana    = EXCLUDED.pay_to_solana,
        pay_to_cosmos    = EXCLUDED.pay_to_cosmos,
        updated_at       = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url,
  tags, price_atomic_min, price_atomic_max, price_unit,
  networks, status, resource_key_id, slug,
  sample_request_json, sample_response_json,
  proxy_config_id
)
SELECT
  gen_random_uuid(),
  'SuVerse Solana Transaction Decoder',
  'Decode any Solana transaction by signature into a structured human-readable summary. Returns invoked programs, token balance changes, fees in SOL and USD, instruction flow, and one-line summary. Powered by SuVerse infrastructure on top of Solana mainnet. Multi-network payment — pay with Base USDC, Solana USDC, or Cosmos USDC.',
  'https://proxy.suverse.io/v1/data/suverse-solana-tx-decoder',
  ARRAY['solana','transaction','decode','helius','suverse'],
  50000,
  50000,
  'per-call',
  ARRAY['eip155:8453','solana:mainnet','cosmos:noble-1'],
  'approved',
  proxy_ins.resource_key_id,
  'suverse-solana-tx-decoder',
  '{"signature":"3eJy4KZyBmwkhjq3nnbtN3QgrB2nsR37zRtwp77eK6fHytVNhyhudT9749ZQWmPD73RuV3YwBAPk1wQzkdLZQkzY"}',
  '{"signature":"3eJy4KZyBmwkhjq3nnbtN3QgrB2nsR37zRtwp77eK6fHytVNhyhudT9749ZQWmPD73RuV3YwBAPk1wQzkdLZQkzY","slot":423509905,"blockTime":1780284321,"fee":5045,"payer":"6MtMPMgLKckpeaZo4io9EiguGsrwSfwZ5pzMbTCwM8LQ","summary":"6MtMPMgLKckpeaZo4io9EiguGsrwSfwZ5pzMbTCwM8LQ swapped 398.680672 USDC for 399.087487 USDT","type":"SWAP","source":"JUPITER","instructions":[{"programId":"JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"}],"tokenTransfers":[{"fromUserAccount":"6MtMPMgLKckpeaZo4io9EiguGsrwSfwZ5pzMbTCwM8LQ","mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","tokenAmount":398.680672}],"nativeTransfers":[]}',
  proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;

COMMIT;
