-- 033_proxy_log_user_agent.sql — capture inbound User-Agent on every
-- proxy request, so we can attribute traffic to known x402 catalog
-- crawlers (PayAI-Uptime, Analytix402, x402scan probes, etc.) without
-- needing the on-chain payer trace.
--
-- The column is nullable: many older rows pre-date this migration and
-- some clients legitimately omit the header. Free-form TEXT — UAs
-- range from short cron tokens to multi-hundred-char browser strings;
-- no length cap. No index — this is an audit/forensics column read
-- only by ad-hoc queries, not the hot path.

ALTER TABLE proxy_request_logs
  ADD COLUMN IF NOT EXISTS user_agent TEXT;
