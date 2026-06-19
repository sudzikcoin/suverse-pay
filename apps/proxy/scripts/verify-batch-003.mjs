#!/usr/bin/env node
// Auto-verification for the batch-003 100/day run. Checks the three
// acceptance criteria and prints a machine-readable VERDICT line.
//   1. CDP merchant indexing rate for the batch payTo (target >=95%).
//   2. zero settled-then-4xx (proxy charged then upstream errored).
//   3. no shared-config regression (batch-001/002 sample still 402+3 accepts).
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
const __dirname = dirname(fileURLToPath(import.meta.url));
const PAYTO = process.argv[2] || "0x7d7cE550251fd81457Bfe9afB40c800C2CD50A73";
const B = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/merchant";

async function feed(p) {
  let res = [], off = 0, t = null;
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${B}?payTo=${p}&limit=100&offset=${off}`);
    const j = await r.json(); t = j.pagination?.total;
    const rr = j.resources || []; res.push(...rr);
    if (res.length >= t || rr.length === 0) break; off += 100;
  }
  return new Set(res.map((x) => (x.resource || "").match(/\/v1\/data\/([a-z0-9-]+)/)?.[1]).filter(Boolean));
}
async function probe(slug) {
  const r = await fetch(`https://proxy.suverse.io/v1/data/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  let acc = 0; try { acc = (await r.json()).accepts?.length || 0; } catch {}
  return r.status === 402 && acc === 3;
}

async function main() {
  const b3 = JSON.parse(readFileSync(resolve(__dirname, "..", "..", "..", "scripts", "pipeline", "manifest-batch-003.json"), "utf8")).map((r) => r.slug);
  const idx = await feed(PAYTO);
  const indexed = b3.filter((s) => idx.has(s));
  const missing = b3.filter((s) => !idx.has(s));
  const rate = (indexed.length / b3.length * 100).toFixed(1);

  // settled-then-4xx for batch-003 (proxy charged, upstream 4xx/5xx)
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM proxy_request_logs prl
       JOIN seller_proxy_configs spc ON spc.id=prl.proxy_config_id
      WHERE spc.public_slug = ANY($1) AND prl.outcome='settled' AND prl.upstream_status >= 400`,
    [b3],
  );
  const settledThen4xx = rows[0].n;
  const { rows: oc } = await pool.query(
    `SELECT prl.outcome, prl.upstream_status, count(*)::int AS n FROM proxy_request_logs prl
       JOIN seller_proxy_configs spc ON spc.id=prl.proxy_config_id
      WHERE spc.public_slug = ANY($1) AND prl.created_at > now()-interval '2 hours'
      GROUP BY 1,2 ORDER BY 1,2`, [b3]);
  await pool.end();

  // regression sample
  const regSlugs = ["suverse-treasury-avg-rates", "suverse-weather-current", "suverse-cisa-kev", "suverse-fx-latest-pair", "suverse-vin-decode", "suverse-eonet-events"];
  const reg = await Promise.all(regSlugs.map(probe));
  const regOk = reg.filter(Boolean).length;

  console.log(`indexing: ${indexed.length}/${b3.length} (${rate}%)`);
  console.log(`settled-then-4xx: ${settledThen4xx}`);
  console.log(`regression sample (402+3accepts): ${regOk}/${regSlugs.length}`);
  console.log(`settle outcomes:`, JSON.stringify(oc));
  if (missing.length) console.log(`still-unindexed (${missing.length}):`, missing.join(","));
  const pass = Number(rate) >= 95 && settledThen4xx === 0 && regOk === regSlugs.length;
  console.log(`VERDICT ${JSON.stringify({ indexedRate: Number(rate), indexed: indexed.length, total: b3.length, settledThen4xx, regOk, regTotal: regSlugs.length, pass })}`);
}
main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
