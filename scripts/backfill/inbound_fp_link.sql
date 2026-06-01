-- backfill/inbound_fp_link.sql — one-off operator script to fill the
-- historical `proxy_request_logs.facilitator_payment_id` gap.
--
-- Run once after the P1 attribution fix lands:
--
--   psql "$DATABASE_URL" -f scripts/backfill/inbound_fp_link.sql
--
-- Not a migration: pg-mem 3.0.14 mis-parses UPDATE…FROM with
-- table-qualified column names, breaking the db test suite if this
-- runs on every test boot. Production gets the one-time UPDATE
-- behavior via psql; fresh dev/CI databases have no rows to
-- backfill, so the script is a no-op there.
--
-- Background: before the P1 fix the proxy never wrote the FK link
-- from a settled proxy_request_logs row to the inbound
-- facilitator_payments row written by services/facilitator under the
-- proxy-operator's resource_key. Every prl row that was paid for the
-- past ~weeks has `facilitator_payment_id IS NULL` even though the
-- payment is sitting in facilitator_payments two table-rows away.
--
-- For every settled prl row where (tx_hash, network) uniquely
-- identify an inbound facilitator_payments row, link them up. This
-- lets the dashboard's "who paid me" / payer-attribution queries
-- answer correctly for the historical window without a one-off
-- script. Rows where the lookup is ambiguous or empty are left as
-- NULL — the unique partial subquery filter ensures we never blindly
-- pick a wrong row.

-- pg-mem 3.0.14 gotcha: `UPDATE t AS x` (or unprefixed-alias) silently
-- mis-resolves columns at parse time. Write the UPDATE without an
-- alias on the target table and qualify the FROM-side with its own
-- alias only. See reference_pgmem_gotchas in user memory.

UPDATE proxy_request_logs
   SET facilitator_payment_id = fp.id
  FROM facilitator_payments fp
 WHERE proxy_request_logs.outcome = 'settled'
   AND proxy_request_logs.facilitator_payment_id IS NULL
   AND proxy_request_logs.tx_hash IS NOT NULL
   AND fp.tx_hash = proxy_request_logs.tx_hash
   AND fp.network = proxy_request_logs.network
   AND fp.direction = 'inbound'
   AND fp.status = 'settled'
   -- Guard against ambiguous joins — only link when exactly one
   -- inbound fp row exists for this (tx_hash, network). Two
   -- inbound rows on the same tx_hash would be a data bug we
   -- shouldn't paper over.
   AND (
     SELECT COUNT(*) FROM facilitator_payments fp2
      WHERE fp2.tx_hash = proxy_request_logs.tx_hash
        AND fp2.network = proxy_request_logs.network
        AND fp2.direction = 'inbound'
   ) = 1;
