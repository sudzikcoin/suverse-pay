// 3 real internal test calls of crypto_market_pulse through the BUILT
// dist artifact, with the real DB pool and real upstreams — the same
// code path the paid endpoint dispatches to (preflight first, then
// handler with preflightData threaded through, exactly like handler.ts).
import { writeFileSync } from "node:fs";
import pg from "pg";
import {
  cryptoMarketPulse,
  cryptoMarketPulsePreflight,
} from "/home/govhub/suverse-pay/apps/proxy/dist/handlers/crypto-market-pulse.js";

const pool = new pg.Pool({
  connectionString: "postgres://suverse:suverse@localhost:5433/suverse_pay",
  max: 4,
});

const latencies = [];
for (let i = 1; i <= 3; i++) {
  const t0 = Date.now();
  const pf = await cryptoMarketPulsePreflight({ body: null, method: "POST", db: pool });
  if (!pf.proceed) {
    console.error(`call ${i}: preflight refused`, JSON.stringify(pf));
    process.exit(1);
  }
  const res = await cryptoMarketPulse({
    body: Buffer.from("{}"),
    method: "POST",
    db: pool,
    preflightData: pf.data,
  });
  const ms = Date.now() - t0;
  latencies.push(ms);
  console.log(`call ${i}: status=${res.status} latency=${ms}ms regime=${res.body?.verdict?.regime} confidence=${res.body?.verdict?.confidence} stale=${JSON.stringify(res.body?.data_quality?.stale_sources)}`);
  writeFileSync(`/tmp/cmp-build-report/samples/pulse-call-${i}.json`, JSON.stringify(res.body, null, 2));
}
console.log("latencies:", latencies.join(","), "p50:", latencies.sort((a,b)=>a-b)[1]);
await pool.end();
