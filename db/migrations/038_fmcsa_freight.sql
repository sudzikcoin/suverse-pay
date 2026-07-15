-- 038_fmcsa_freight.sql — FMCSA Motus mirror + per-DOT caches for the freight
-- verdict endpoints (carrier-risk-verdict, broker-authority-check).
--
-- Mirrored daily (full re-pull, ~570k rows total) from data.transportation.gov
-- Motus "All With History" datasets by scripts/freight/ingest-fmcsa.mjs:
--   fmcsa_insur     <- c5y8-a4uz  Motus Insur - All With History
--   fmcsa_inshist   <- 3uet-3z4i  Motus InsHist - All With History
--   fmcsa_authhist  <- yu5v-wbh6  Motus AuthHist - All With History
--   fmcsa_revoke    <- wb4f-neki  Motus RevokeSuspend - All With History
--   fmcsa_boc3      <- 6snj-ed7q  Motus BOC3 - All With History
--   fmcsa_carrier   <- inys-ebih  Motus Carrier - All With History
--
-- Census (az4n-8mr2, 4.47M rows) and inspections (fx4q-ay7w, 8.3M rows) are NOT
-- mirrored; handlers query Socrata live per-DOT and cache here (stale-if-error).
--
-- docket_norm = UPPER(docket) with non-alphanumerics stripped ("MC-424836" and
-- "MC424836" both normalize to "MC424836"); computed by the ingest script.
-- pg-mem: no gen_random_uuid()/serial defaults anywhere — app supplies keys.

CREATE TABLE IF NOT EXISTS fmcsa_insur (
  docket_number TEXT,
  docket_norm TEXT,
  usdot_number TEXT,
  ins_form_code TEXT,
  ins_type_code TEXT,
  ins_class_code TEXT,
  max_cov_amount NUMERIC,
  underl_lim_amount NUMERIC,
  policy_no TEXT,
  effective_date DATE,
  insurance_company_name TEXT,
  trans_date DATE
);
CREATE INDEX IF NOT EXISTS fmcsa_insur_docket_idx ON fmcsa_insur (docket_norm);
CREATE INDEX IF NOT EXISTS fmcsa_insur_dot_idx ON fmcsa_insur (usdot_number);

CREATE TABLE IF NOT EXISTS fmcsa_inshist (
  docket_number TEXT,
  docket_norm TEXT,
  usdot_number TEXT,
  ins_form_code TEXT,
  filing_status_reason TEXT,
  ins_type_code TEXT,
  ins_type_ind TEXT,
  policy_no TEXT,
  ins_type_desc TEXT,
  min_cov_amount NUMERIC,
  ins_class_code TEXT,
  effective_date DATE,
  underl_lim_amount NUMERIC,
  max_cov_amount NUMERIC,
  cancl_effective_date DATE,
  insurance_company_name TEXT
);
CREATE INDEX IF NOT EXISTS fmcsa_inshist_docket_idx ON fmcsa_inshist (docket_norm);
CREATE INDEX IF NOT EXISTS fmcsa_inshist_dot_idx ON fmcsa_inshist (usdot_number);

CREATE TABLE IF NOT EXISTS fmcsa_authhist (
  docket_number TEXT,
  docket_norm TEXT,
  usdot_number TEXT,
  op_auth_type TEXT,
  op_auth_status TEXT,
  reason TEXT,
  status_change_date DATE
);
CREATE INDEX IF NOT EXISTS fmcsa_authhist_docket_idx ON fmcsa_authhist (docket_norm);
CREATE INDEX IF NOT EXISTS fmcsa_authhist_dot_idx ON fmcsa_authhist (usdot_number);

CREATE TABLE IF NOT EXISTS fmcsa_revoke (
  docket_number TEXT,
  docket_norm TEXT,
  usdot_number TEXT,
  op_auth_type TEXT,
  order1_serve_date DATE,
  order1_type_desc TEXT,
  order1_effective_date DATE
);
CREATE INDEX IF NOT EXISTS fmcsa_revoke_docket_idx ON fmcsa_revoke (docket_norm);
CREATE INDEX IF NOT EXISTS fmcsa_revoke_dot_idx ON fmcsa_revoke (usdot_number);

CREATE TABLE IF NOT EXISTS fmcsa_boc3 (
  docket_number TEXT,
  docket_norm TEXT,
  usdot_number TEXT,
  co_name TEXT,
  street_po TEXT,
  city TEXT,
  state_code TEXT,
  zip_code TEXT,
  ctry_code TEXT
);
CREATE INDEX IF NOT EXISTS fmcsa_boc3_docket_idx ON fmcsa_boc3 (docket_norm);
CREATE INDEX IF NOT EXISTS fmcsa_boc3_dot_idx ON fmcsa_boc3 (usdot_number);

CREATE TABLE IF NOT EXISTS fmcsa_carrier (
  docket_number TEXT,
  docket_norm TEXT,
  usdot_number TEXT,
  rfc_number TEXT,
  op_auth_type TEXT,
  op_auth_status TEXT,
  min_cov_amount NUMERIC,
  cargo_req TEXT,
  bond_req TEXT,
  bipd_file TEXT,
  cargo_file TEXT,
  bond_file TEXT,
  bus_undeliverable_mail TEXT,
  mail_undeliverable_mail TEXT,
  dba_name TEXT,
  legal_name TEXT,
  bus_street_po TEXT,
  bus_colonia TEXT,
  bus_city TEXT,
  bus_state_code TEXT,
  bus_ctry_code TEXT,
  bus_zip_code TEXT,
  bus_telno TEXT,
  mail_street_po TEXT,
  mail_colonia TEXT,
  mail_city TEXT,
  mail_state_code TEXT,
  mail_ctry_code TEXT,
  mail_zip_code TEXT
);
CREATE INDEX IF NOT EXISTS fmcsa_carrier_docket_idx ON fmcsa_carrier (docket_norm);
CREATE INDEX IF NOT EXISTS fmcsa_carrier_dot_idx ON fmcsa_carrier (usdot_number);

-- Per-DOT live-lookup caches (census + inspection summaries), stale-if-error.
CREATE TABLE IF NOT EXISTS fmcsa_census_cache (
  dot_number TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL
);

-- Census snapshots accumulate an MCS-150 time series (fleet-jump fraud signal);
-- one row per DOT per day, written on every paid lookup.
CREATE TABLE IF NOT EXISTS fmcsa_census_snapshots (
  dot_number TEXT NOT NULL,
  snapshot_date DATE NOT NULL,
  power_units INTEGER,
  total_drivers INTEGER,
  mcs150_date TEXT,
  mcs150_mileage BIGINT,
  payload JSONB NOT NULL,
  PRIMARY KEY (dot_number, snapshot_date)
);

CREATE TABLE IF NOT EXISTS fmcsa_inspection_cache (
  dot_number TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL
);

-- Generic small HTTP cache for the road-conditions / reefer-rate upstreams
-- (WZDx feeds, USDA MARS reports). Keyed by a handler-chosen cache_key.
CREATE TABLE IF NOT EXISTS freight_http_cache (
  cache_key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL
);

-- Bookkeeping for the daily mirror; handlers read the latest ok run per
-- dataset to disclose extract freshness in data_quality.
CREATE TABLE IF NOT EXISTS fmcsa_ingest_runs (
  dataset TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  row_count BIGINT,
  max_date TEXT,
  status TEXT NOT NULL,
  error TEXT,
  PRIMARY KEY (dataset, started_at)
);
