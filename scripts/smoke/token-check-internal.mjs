// Smoke: real internal token-check calls through the BUILT handler
// (dist), live DB + live upstreams — exactly what the dispatcher runs,
// minus the payment leg. Usage:
//   node --env-file=../../.env token-check-internal.mjs [--latency N]
import { tokenCheck, tokenCheckPreflight } from "./dist/handlers/token-check.js";
import pg from "pg";
import { writeFileSync } from "node:fs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

const CASES = [
  ["bonk_major", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"],
  ["elite_memecoin", "78B31QV1rtyoe2EYvVNjBVjeowyrtcH5FPTE4tCypump"],
  ["thin_zero_elite", "2bqW58sVYxsDjp4kcfdLhVtyx7mkJFgdrFRbvMKipump"],
  ["invalid_input", "not-a-mint!!"],
];

async function callOnce(mint) {
  const body = Buffer.from(JSON.stringify({ token: mint }));
  const t0 = performance.now();
  const pf = await tokenCheckPreflight({ body, method: "POST", db: pool });
  if (!pf.proceed) {
    return { ms: performance.now() - t0, status: pf.status, body: pf.body, settled: false };
  }
  const res = await tokenCheck({ body, method: "POST", db: pool, preflightData: pf.data });
  return { ms: performance.now() - t0, status: res.status, body: res.body, settled: true };
}

const latencyRuns = process.argv.includes("--latency")
  ? Number(process.argv[process.argv.indexOf("--latency") + 1] ?? 5)
  : 0;

for (const [label, mint] of CASES) {
  const r = await callOnce(mint);
  const v = r.body?.verdict;
  console.log(
    `${label.padEnd(16)} status=${r.status} would_settle=${r.settled} ${Math.round(r.ms)}ms` +
      (v ? ` risk=${v.risk_level} conf=${v.confidence} flags=[${v.flags}]` : ` body=${JSON.stringify(r.body).slice(0, 120)}`),
  );
  if (v) {
    const s = r.body.signals;
    console.log(
      `  liq=${s.liquidity.bucket}(${s.liquidity.price_impact_pct_500_usd}%) conc=${s.concentration.bucket}` +
        `(wallet=${s.concentration.wallet_held_top10_pct} pool=${s.concentration.pool_held_top10_pct} src=${s.concentration.source})` +
        ` age=${s.age.bucket} elite=${s.elite_flow.status} feed_lag=${s.elite_flow.elite_feed_lag_hours}h`,
    );
    if (s.elite_flow.card) console.log(`  elite card:`, JSON.stringify(s.elite_flow.card));
    console.log(`  summary: ${v.summary}`);
  }
  writeFileSync(`/tmp/token-check-build/samples/internal_${label}.json`, JSON.stringify(r.body, null, 1));
}

if (latencyRuns > 0) {
  const lat = [];
  for (let i = 0; i < latencyRuns; i++) {
    for (const [label, mint] of CASES.slice(0, 3)) {
      const r = await callOnce(mint);
      lat.push(r.ms);
      console.log(`latency ${label} run${i}: ${Math.round(r.ms)}ms`);
    }
  }
  lat.sort((a, b) => a - b);
  const p50 = lat[Math.floor(lat.length / 2)];
  console.log(`\nLATENCY n=${lat.length} p50=${Math.round(p50)}ms min=${Math.round(lat[0])}ms max=${Math.round(lat[lat.length - 1])}ms`);
}
await pool.end();
