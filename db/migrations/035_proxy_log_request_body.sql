-- 035_proxy_log_request_body.sql — capture the parsed JSON request
-- body for /v1/data/* POST traffic in proxy_request_logs, so we can
-- reconstruct WHAT agents asked our first-party endpoints (the
-- 2026-06-08 agent session left three smart-money-netflow calls whose
-- chain/time_window params were unrecoverable — cmp-research §1b).
--
-- Scope and caps live in code, not in the schema:
--   - only /v1/data/* POST bodies are written (legacy /v1/proxy/*
--     routes forward third-party payloads we don't retain);
--   - the writer caps serialized size at 8 KiB — oversize or
--     unparseable bodies are stored as small marker objects
--     ({"_oversize":true,...} / {"_unparseable":true,...}).
--
-- Nullable (pre-035 rows, GET traffic, empty bodies). No index —
-- forensics-only column read by ad-hoc queries, never the hot path.

ALTER TABLE proxy_request_logs
  ADD COLUMN IF NOT EXISTS request_body JSONB;
