#!/usr/bin/env node
/**
 * ingest-fmcsa.mjs — daily full re-pull of the FMCSA Motus "All With History"
 * datasets from data.transportation.gov (Socrata SODA) into Postgres, for the
 * freight verdict endpoints (carrier-risk-verdict, broker-authority-check).
 *
 * Full re-pull by design: the six files total ~570k rows; a diff protocol
 * would save nothing and add failure modes. Each dataset is replaced inside
 * one transaction (DELETE + batched INSERT), so a mid-run crash or upstream
 * outage keeps yesterday's data intact (fail-safe). Every run is recorded in
 * fmcsa_ingest_runs; handlers read the latest ok run to disclose freshness.
 *
 *   DATABASE_URL=postgres://... node scripts/freight/ingest-fmcsa.mjs [--only fmcsa_insur]
 *
 * Falls back to DATABASE_URL from /etc/suverse-pay/proxy.env when unset
 * (same env file the proxy service reads). Optional SOCRATA_APP_TOKEN raises
 * Socrata rate limits; anonymous works.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Resolve pg from the proxy workspace (pnpm layout — no root node_modules/pg).
const require = createRequire(new URL("../../apps/proxy/anchor.js", import.meta.url));
const { Pool } = require("pg");

const SODA_BASE = "https://data.transportation.gov/resource";
const PAGE_SIZE = 50000;
const FETCH_TIMEOUT_MS = 120_000;

// dataset id -> { table, columns: [socrata field -> insert value fn] }
const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : null;
};
const int = (v) => {
  if (v == null || v === "") return null;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? String(n) : null;
};
// Motus dates are YYYYMMDD strings; tolerate ISO too; garbage -> null.
const ymd = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return `${y}-${mo}-${d}`;
};
const txt = (v) => (v == null || v === "" ? null : String(v));
const docketNorm = (v) =>
  v == null ? null : String(v).toUpperCase().replace(/[^A-Z0-9]/g, "") || null;

const DATASETS = [
  {
    id: "c5y8-a4uz",
    table: "fmcsa_insur",
    maxDateField: "trans_date",
    cols: {
      docket_number: txt, usdot_number: txt, ins_form_code: txt,
      ins_type_code: txt, ins_class_code: txt, max_cov_amount: num,
      underl_lim_amount: num, policy_no: txt, effective_date: ymd,
      insurance_company_name: txt, trans_date: ymd,
    },
  },
  {
    id: "3uet-3z4i",
    table: "fmcsa_inshist",
    maxDateField: "effective_date",
    cols: {
      docket_number: txt, usdot_number: txt, ins_form_code: txt,
      filing_status_reason: txt, ins_type_code: txt, ins_type_ind: txt,
      policy_no: txt, ins_type_desc: txt, min_cov_amount: num,
      ins_class_code: txt, effective_date: ymd, underl_lim_amount: num,
      max_cov_amount: num, cancl_effective_date: ymd, insurance_company_name: txt,
    },
  },
  {
    id: "yu5v-wbh6",
    table: "fmcsa_authhist",
    maxDateField: "status_change_date",
    cols: {
      docket_number: txt, usdot_number: txt, op_auth_type: txt,
      op_auth_status: txt, reason: txt, status_change_date: ymd,
    },
  },
  {
    id: "wb4f-neki",
    table: "fmcsa_revoke",
    maxDateField: "order1_serve_date",
    cols: {
      docket_number: txt, usdot_number: txt, op_auth_type: txt,
      order1_serve_date: ymd, order1_type_desc: txt, order1_effective_date: ymd,
    },
  },
  {
    id: "6snj-ed7q",
    table: "fmcsa_boc3",
    maxDateField: null,
    cols: {
      docket_number: txt, usdot_number: txt, co_name: txt, street_po: txt,
      city: txt, state_code: txt, zip_code: txt, ctry_code: txt,
    },
  },
  {
    id: "inys-ebih",
    table: "fmcsa_carrier",
    maxDateField: null,
    cols: {
      docket_number: txt, usdot_number: txt, rfc_number: txt, op_auth_type: txt,
      op_auth_status: txt, min_cov_amount: num, cargo_req: txt, bond_req: txt,
      bipd_file: txt, cargo_file: txt, bond_file: txt,
      bus_undeliverable_mail: txt, mail_undeliverable_mail: txt, dba_name: txt,
      legal_name: txt, bus_street_po: txt, bus_colonia: txt, bus_city: txt,
      bus_state_code: txt, bus_ctry_code: txt, bus_zip_code: txt, bus_telno: txt,
      mail_street_po: txt, mail_colonia: txt, mail_city: txt,
      mail_state_code: txt, mail_ctry_code: txt, mail_zip_code: txt,
    },
  },
];

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = readFileSync("/etc/suverse-pay/proxy.env", "utf8");
  const m = /^DATABASE_URL=(.+)$/m.exec(env);
  if (!m) throw new Error("DATABASE_URL not set and not found in /etc/suverse-pay/proxy.env");
  return m[1].trim();
}

async function fetchPage(datasetId, offset) {
  const url = new URL(`${SODA_BASE}/${datasetId}.json`);
  url.searchParams.set("$limit", String(PAGE_SIZE));
  url.searchParams.set("$offset", String(offset));
  url.searchParams.set("$order", ":id");
  const headers = { accept: "application/json" };
  if (process.env.SOCRATA_APP_TOKEN) headers["X-App-Token"] = process.env.SOCRATA_APP_TOKEN;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`socrata ${datasetId} HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, attempt * 5000));
    }
  }
}

async function ingestDataset(pool, ds) {
  const startedAt = new Date().toISOString();
  const colNames = Object.keys(ds.cols);
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await fetchPage(ds.id, offset);
    rows.push(...page);
    process.stdout.write(`  ${ds.table}: fetched ${rows.length}\r`);
    if (page.length < PAGE_SIZE) break;
  }
  console.log(`  ${ds.table}: fetched ${rows.length} rows total`);
  if (rows.length === 0) throw new Error(`${ds.id} returned 0 rows — refusing to wipe ${ds.table}`);

  let maxDate = null;
  if (ds.maxDateField) {
    for (const r of rows) {
      const d = ymd(r[ds.maxDateField]);
      if (d && (!maxDate || d > maxDate)) maxDate = d;
    }
  }

  const insertCols = ["docket_norm", ...colNames];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM ${ds.table}`);
    const BATCH = 2000;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const values = [];
      const params = [];
      let p = 1;
      for (const r of chunk) {
        const vals = [docketNorm(r.docket_number)];
        for (const c of colNames) vals.push(ds.cols[c](r[c]));
        values.push(`(${vals.map(() => `$${p++}`).join(",")})`);
        params.push(...vals);
      }
      await client.query(
        `INSERT INTO ${ds.table} (${insertCols.join(",")}) VALUES ${values.join(",")}`,
        params,
      );
    }
    await client.query(
      `INSERT INTO fmcsa_ingest_runs (dataset, started_at, finished_at, row_count, max_date, status)
       VALUES ($1, $2, NOW(), $3, $4, 'ok')`,
      [ds.table, startedAt, rows.length, maxDate],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  console.log(`  ${ds.table}: replaced, max_date=${maxDate ?? "n/a"}`);
}

async function main() {
  const onlyIdx = process.argv.indexOf("--only");
  const only = onlyIdx === -1 ? null : process.argv[onlyIdx + 1];
  const pool = new Pool({ connectionString: databaseUrl(), max: 2 });
  let failed = 0;
  for (const ds of DATASETS) {
    if (only && ds.table !== only) continue;
    console.log(`[${new Date().toISOString()}] ingest ${ds.table} <- ${ds.id}`);
    try {
      await ingestDataset(pool, ds);
    } catch (err) {
      failed++;
      console.error(`  ${ds.table}: FAILED — ${err.message} (previous data kept)`);
      await pool
        .query(
          `INSERT INTO fmcsa_ingest_runs (dataset, started_at, finished_at, row_count, status, error)
           VALUES ($1, NOW(), NOW(), NULL, 'error', $2)`,
          [ds.table, String(err.message).slice(0, 500)],
        )
        .catch(() => {});
    }
  }
  await pool.end();
  if (failed > 0) process.exit(1);
  console.log(`[${new Date().toISOString()}] ingest complete`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
