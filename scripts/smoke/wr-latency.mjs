// p50 latency for the wallet-reputation handler: full dispatcher-shaped
// path (preflight -> threaded data -> handler) against the LIVE db and
// LIVE Helius, 20 iterations alternating the three real test wallets.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import {
  walletReputation,
  walletReputationPreflight,
} from "/home/govhub/suverse-pay/apps/proxy/dist/handlers/wallet-reputation.js";

for (const line of readFileSync("/home/govhub/suverse-pay/.env", "utf8").split("\n")) {
  const m = line.match(/^(DATABASE_URL|HELIUS_API_KEY)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const WALLETS = [
  "CBjwziSG9Z48MSAfqXNuKHyQ3JqrC963pNeivoUSAV5b",
  "CobPeS67MhQo1qa3ZwfMDGaUhcy5uBNKG2GnPkcZdQu8",
  "26edvkZ99Lfs6LEwfSbfbJG17NM6z4BqrWMk7Z8hTe4D",
];

const times = [];
for (let i = 0; i < 20; i++) {
  const wallet = WALLETS[i % WALLETS.length];
  const body = Buffer.from(JSON.stringify({ wallet }));
  const t0 = process.hrtime.bigint();
  const pf = await walletReputationPreflight({ body, method: "POST", db: pool });
  if (!pf.proceed) throw new Error(`preflight failed: ${JSON.stringify(pf.body)}`);
  const res = await walletReputation({ body, method: "POST", db: pool, preflightData: pf.data });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  times.push(ms);
  console.log(`#${String(i + 1).padStart(2)} ${wallet.slice(0, 8)}… ${ms.toFixed(1)}ms tier=${res.body.verdict.tier} stale=${JSON.stringify(res.body.data_quality.stale_sources)}`);
}
times.sort((a, b) => a - b);
const pct = (p) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))];
const stats = {
  n: times.length,
  p50_ms: Number(pct(50).toFixed(1)),
  p90_ms: Number(pct(90).toFixed(1)),
  min_ms: Number(times[0].toFixed(1)),
  max_ms: Number(times[times.length - 1].toFixed(1)),
};
console.log("latency:", JSON.stringify(stats));
mkdirSync("/tmp/wr-build-report", { recursive: true });
writeFileSync("/tmp/wr-build-report/latency.json", JSON.stringify({ ...stats, all_ms: times.map((t) => Number(t.toFixed(1))) }, null, 2));
await pool.end();
