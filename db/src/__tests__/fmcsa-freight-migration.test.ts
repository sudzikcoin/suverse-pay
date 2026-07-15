import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";

function newPgMem() {
  const db = newDb({ noAstCoverageCheck: true });
  const { Pool } = db.adapters.createPg();
  return new Pool() as unknown as {
    query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
    end: () => Promise<void>;
  };
}

describe("038_fmcsa_freight", () => {
  let pool: ReturnType<typeof newPgMem> | null = null;

  beforeEach(async () => {
    pool = newPgMem();
    await runMigrations({ client: pool as never, log: () => {} });
  });
  afterEach(async () => {
    await pool?.end();
    pool = null;
  });

  it("creates the mirror, cache and bookkeeping tables", async () => {
    for (const t of [
      "fmcsa_insur",
      "fmcsa_inshist",
      "fmcsa_authhist",
      "fmcsa_revoke",
      "fmcsa_boc3",
      "fmcsa_carrier",
      "fmcsa_census_cache",
      "fmcsa_census_snapshots",
      "fmcsa_inspection_cache",
      "freight_http_cache",
      "fmcsa_ingest_runs",
    ]) {
      const { rows } = await pool!.query(
        `SELECT table_name FROM information_schema.tables WHERE table_name = $1`,
        [t],
      );
      expect(rows.length, `table ${t} should exist`).toBeGreaterThan(0);
    }
  });

  it("accepts the shapes the ingest script and handlers write", async () => {
    await pool!.query(
      `INSERT INTO fmcsa_insur
         (docket_norm, docket_number, usdot_number, ins_form_code, ins_type_code,
          ins_class_code, max_cov_amount, underl_lim_amount, policy_no,
          effective_date, insurance_company_name, trans_date)
       VALUES ('MC424836','MC-424836','1006607','91X','1','P',
               '1000000','0','POL-1','2026-06-01','ACME INSURANCE','2026-07-15')`,
    );
    await pool!.query(
      `INSERT INTO fmcsa_authhist
         (docket_norm, docket_number, usdot_number, op_auth_type, op_auth_status,
          reason, status_change_date)
       VALUES ('MC424836','MC-424836','1006607','Motor Carrier of Property (Except Household Goods)',
               'Active', NULL, '2024-01-02')`,
    );
    await pool!.query(
      `INSERT INTO fmcsa_ingest_runs (dataset, started_at, finished_at, row_count, max_date, status)
       VALUES ('fmcsa_insur', NOW(), NOW(), 261217, '2026-07-15', 'ok')`,
    );
    await pool!.query(
      `INSERT INTO fmcsa_census_cache (dot_number, payload, fetched_at)
       VALUES ('1006607', '{"legal_name":"TEST"}', NOW())`,
    );
    await pool!.query(
      `INSERT INTO fmcsa_census_snapshots
         (dot_number, snapshot_date, power_units, total_drivers, mcs150_date, mcs150_mileage, payload)
       VALUES ('1006607', '2026-07-15', 12, 14, '2025-11-02', 1200000, '{}')`,
    );

    const ins = await pool!.query(
      `SELECT usdot_number, max_cov_amount FROM fmcsa_insur WHERE docket_norm = $1`,
      ["MC424836"],
    );
    expect(ins.rows.length).toBe(1);
    expect((ins.rows[0] as { usdot_number: string }).usdot_number).toBe("1006607");

    const auth = await pool!.query(
      `SELECT op_auth_status FROM fmcsa_authhist
        WHERE usdot_number = $1 ORDER BY status_change_date DESC`,
      ["1006607"],
    );
    expect((auth.rows[0] as { op_auth_status: string }).op_auth_status).toBe("Active");
  });
});
