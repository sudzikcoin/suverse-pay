#!/usr/bin/env node
/**
 * run-handler.mjs — invoke a built internal handler directly (preflight
 * then handler, exactly like the paid path) against the prod DB and live
 * upstreams, WITHOUT any x402 payment. Used to produce the live sample
 * responses in build reports and to smoke-test handlers after deploy.
 *
 *   node scripts/freight/run-handler.mjs carrier_risk_verdict '{"dot":"264184"}'
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../apps/proxy/anchor.js", import.meta.url));
const { Pool } = require("pg");

const [, , name, bodyJson] = process.argv;
if (!name) {
  console.error("usage: run-handler.mjs <handler_name> '<json body>'");
  process.exit(2);
}

const registry = await import("../../apps/proxy/dist/handlers/registry.js");
const handler = registry.getInternalHandler(name);
if (!handler) {
  console.error(`unknown handler: ${name}`);
  process.exit(2);
}

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = readFileSync("/etc/suverse-pay/proxy.env", "utf8");
  return /^DATABASE_URL=(.+)$/m.exec(env)[1].trim();
}

const pool = new Pool({ connectionString: databaseUrl(), max: 2 });
const input = {
  body: bodyJson ? Buffer.from(bodyJson, "utf8") : null,
  method: "POST",
  db: pool,
};

const preflight = registry.getInternalHandlerPreflight(name);
let preflightData;
if (preflight) {
  const pf = await preflight(input);
  if (!pf.proceed) {
    console.log(JSON.stringify({ preflight_blocked: true, status: pf.status, body: pf.body }, null, 2));
    await pool.end();
    process.exit(0);
  }
  preflightData = pf.data;
}
const t0 = Date.now();
const res = await handler({ ...input, preflightData });
console.log(JSON.stringify({ status: res.status, latency_ms: Date.now() - t0, body: res.body }, null, 2));
await pool.end();
