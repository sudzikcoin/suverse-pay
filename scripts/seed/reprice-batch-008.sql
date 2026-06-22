-- reprice-batch-008.sql
-- Bring the batch-008 in-house smart-money/wallet endpoints up to the
-- $0.05-0.10 per-call pricing rule. They were seeded at the cheap demand-map
-- numbers ($0.02-$0.03); the pricing rule sets a $0.05 floor (50000 atomic,
-- USDC 6-decimals). Idempotent, slug-scoped UPDATE on both
-- seller_proxy_configs.price_atomic AND catalog_listings.price_atomic_{min,max}
-- so the openapi.json + CDP listing advertise the real price.
-- smart-money-top-wallets is already 50000 and untouched.

BEGIN;

UPDATE seller_proxy_configs
SET price_atomic = 50000, updated_at = now()
WHERE public_slug IN (
    'smart-money-token-rankings','smart-money-accumulation',
    'smart-money-distribution','wallet-label-lookup'
  )
  AND price_atomic < 50000;

UPDATE catalog_listings cl
SET price_atomic_min = spc.price_atomic,
    price_atomic_max = spc.price_atomic,
    updated_at = now()
FROM seller_proxy_configs spc
WHERE cl.proxy_config_id = spc.id
  AND spc.public_slug IN (
    'smart-money-token-rankings','smart-money-accumulation',
    'smart-money-distribution','wallet-label-lookup'
  )
  AND (cl.price_atomic_min <> spc.price_atomic OR cl.price_atomic_max <> spc.price_atomic);

COMMIT;
