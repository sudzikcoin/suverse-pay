-- 036_mpp_tempo_enabled.sql — per-endpoint flag for the MPP/Tempo rail.
--
-- Task 39a-rescoped: the proxy can additionally accept Machine
-- Payments Protocol (draft-ryan-httpauth-payment) tempo/charge
-- payments on Tempo (EVM, mainnet eip155:4217 / testnet
-- eip155:42431). The rail is doubly gated:
--
--   1. process-level: MPP_TEMPO_ENABLED=true + MPP_SECRET_KEY in the
--      proxy environment (off → handler behaves exactly as before),
--   2. row-level: this column on seller_proxy_configs, default FALSE.
--
-- Only rows with a non-null pay_to_evm can meaningfully enable it —
-- Tempo is an EVM chain and the rail reuses the row's EVM payout
-- address as the on-Tempo recipient. The handler enforces that at
-- challenge time; no DB constraint so the dashboard can toggle the
-- flag before wallets are configured.

ALTER TABLE seller_proxy_configs
  ADD COLUMN IF NOT EXISTS mpp_tempo_enabled BOOLEAN NOT NULL DEFAULT FALSE;
