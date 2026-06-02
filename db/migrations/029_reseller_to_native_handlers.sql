-- 029_reseller_to_native_handlers.sql — retire flaky api.oatp.cc resellers.
--
-- 48h log analysis (2026-06-01..02) showed every "settled but no data
-- returned" loss came from the three OATP-backed reseller proxies:
--   * solana-tx-decoder       → upstream 500/502, 5 paid calls lost (~$1.00)
--   * solana-tx-simulator     → upstream 502, 1 paid call lost ($0.40)
--   * spl-token-safety-check  → upstream 502, 1 paid call lost ($1.00)
--
-- Two of the three already have an in-process equivalent built around
-- Helius (and registered in handlers/registry.ts):
--   * helius_tx_decoder   serves the same shape as suverse-solana-tx-decoder
--   * helius_tx_simulator serves the same shape as suverse-solana-tx-simulator
--
-- Switching `internal_handler` on the existing rows lets the proxy
-- dispatch in-process and entirely bypass api.oatp.cc — both the
-- pre-charge health probe (`handler.ts:264-306`) and the post-settle
-- forward (`handler.ts:385+`) skip the upstream HTTP path when
-- `internal_handler` is set. `original_url` stays as-is for back-compat
-- but is no longer consulted at runtime.
--
-- No native handler exists yet for the safety-scan endpoint, so it's
-- deactivated rather than left bleeding paid calls into a flaky
-- upstream. The row stays in place so analytics + the catalog history
-- aren't broken; reactivate by adding a new internal_handler later or
-- pointing original_url at a working upstream.

UPDATE seller_proxy_configs
   SET internal_handler = 'helius_tx_decoder',
       updated_at       = now()
 WHERE public_slug = 'solana-tx-decoder'
   AND internal_handler IS NULL;

UPDATE seller_proxy_configs
   SET internal_handler = 'helius_tx_simulator',
       updated_at       = now()
 WHERE public_slug = 'solana-tx-simulator'
   AND internal_handler IS NULL;

UPDATE seller_proxy_configs
   SET is_active  = FALSE,
       updated_at = now()
 WHERE public_slug = 'spl-token-safety-check'
   AND is_active  = TRUE;
