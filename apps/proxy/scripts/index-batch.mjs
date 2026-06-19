#!/usr/bin/env node
/**
 * index-batch.mjs — the durable CDP-Bazaar indexing stage of the wrap
 * pipeline. CDP only indexes an endpoint AFTER >=1 Base settle hits it
 * (Task 51 wake). The generator can't settle at codegen time (endpoint
 * isn't live yet), so this is the mandatory POST-deploy stage: it fires
 * exactly ONE Base settle per endpoint — every endpoint, not a sample.
 *
 * Two reasons the old "sample only" approach left ~60 endpoints dark:
 *   1. only a handful of slugs per batch were ever settled, and
 *   2. the declarative preflight REJECTS empty bodies before settlement,
 *      so a `{}` wake (republish-bazaar-all style) never settles a
 *      required-field endpoint. We therefore settle with each slug's
 *      VALID `sampleRequest` from the manifest.
 *
 * Idempotent: queries the CDP merchant feed for the target payTo up
 * front and SKIPS slugs already indexed (unless --force). Safe to re-run.
 *
 * Usage:
 *   PAYER_BASE_PRIVATE_KEY_PATH=/etc/suverse-pay/base-payer.key \
 *   node scripts/pipeline/index-batch.mjs --batch batch-001,batch-002 [--force] [--poll]
 *   node scripts/pipeline/index-batch.mjs --manifest path1,path2 [--payto 0x..]
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SuverseClient } from "@suverselabs/x402-client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = "eip155:8453";
const PROXY = process.env.PROXY_BASE_URL ?? "https://proxy.suverse.io";
const CDP_MERCHANT = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/merchant";
// Default service payTo = the rotation pool's ACTIVE payTo (what wrap-batch
// just assigned this batch), so the skip-check + indexing poll read the
// SAME merchant feed the new settles land in. Falls back to the original.
function poolActivePayTo() {
  try {
    return JSON.parse(readFileSync("/etc/suverse-pay/payto-pool.json", "utf8")).activePayTo
      || "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0";
  } catch {
    return "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0";
  }
}
const DEFAULT_PAYTO = poolActivePayTo();

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

async function cdpIndexedSlugs(payTo) {
  const out = new Set();
  let offset = 0, total = null;
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${CDP_MERCHANT}?payTo=${payTo}&limit=100&offset=${offset}`);
    if (!r.ok) break;
    const j = await r.json();
    total = j.pagination?.total ?? 0;
    for (const res of j.resources ?? []) {
      const m = (res.resource ?? "").match(/\/v1\/data\/([a-z0-9-]+)/);
      if (m) out.add(m[1]);
    }
    offset += 100;
    if (out.size >= total || (j.resources ?? []).length === 0) break;
  }
  return { slugs: out, total };
}

function loadManifests() {
  const batches = String(arg("batch", "")).split(",").filter(Boolean);
  const explicit = String(arg("manifest", "")).split(",").filter(Boolean);
  const paths = explicit.length
    ? explicit
    : batches.map((b) => resolve(__dirname, "..", "..", "..", "scripts", "pipeline", `manifest-${b}.json`));
  const rows = [];
  for (const p of paths) rows.push(...JSON.parse(readFileSync(p, "utf8")));
  return rows;
}

async function main() {
  const keyPath = process.env.PAYER_BASE_PRIVATE_KEY_PATH;
  if (!keyPath) throw new Error("PAYER_BASE_PRIVATE_KEY_PATH required");
  const key = readFileSync(keyPath, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("key must be 0x+64hex");
  const payTo = String(arg("payto", DEFAULT_PAYTO)).toLowerCase();
  const force = arg("force", false);
  const poll = arg("poll", false);

  const rows = loadManifests();
  const before = await cdpIndexedSlugs(payTo);
  console.log(`payTo ${payTo}: ${before.total} indexed in CDP merchant (before)`);

  const onlyArg = arg("only", null);
  const onlySet = onlyArg ? new Set(String(onlyArg).split(",")) : null;
  const pool = onlySet ? rows.filter((r) => onlySet.has(r.slug)) : rows;
  const targets = force ? pool : pool.filter((r) => !before.slugs.has(r.slug));
  console.log(`${pool.length} endpoints in scope; ${targets.length} need indexing settle\n`);
  // Gentle pacing avoids the CDP-facilitator burst-rate 502s seen on a
  // 60-settle backfire (settle_failed, no charge, but wasted attempts).
  const delayMs = Number(arg("delay", 2500));

  const client = new SuverseClient({ wallets: { evm: key }, preferences: { preferredNetwork: BASE } });
  const settled = [], failed = [];
  for (const ep of targets) {
    const url = `${PROXY}/v1/data/${ep.slug}`;
    try {
      const res = await client.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "User-Agent": "suverse-bazaar-index/1.0" },
        body: JSON.stringify(ep.sampleRequest ?? {}),
      });
      const tx = res.payment?.txHash ?? null;
      console.log(`  + ${ep.slug.padEnd(34)} HTTP ${res.response.status} tx=${tx ?? "-"}`);
      tx ? settled.push({ slug: ep.slug, tx }) : failed.push({ slug: ep.slug, why: "no-tx" });
    } catch (e) {
      // A settle that fired but hit an upstream 4xx still wakes the indexer;
      // a true settle_failed (facilitator transient) does not. Record both.
      console.log(`  ! ${ep.slug.padEnd(34)} ${String(e.message).slice(0, 70)}`);
      failed.push({ slug: ep.slug, why: String(e.message).slice(0, 120) });
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  console.log(`\nsettled ${settled.length}/${targets.length}; failed ${failed.length}`);

  if (poll && settled.length) {
    console.log("\npolling CDP merchant for indexing (up to 180s)...");
    const want = new Set(settled.map((s) => s.slug));
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 15000));
      const now = await cdpIndexedSlugs(payTo);
      const seen = [...want].filter((s) => now.slugs.has(s)).length;
      console.log(`  t+${(i + 1) * 15}s: ${seen}/${want.size} newly-settled now visible; payTo total=${now.total}`);
      if (seen >= want.size) break;
    }
  }
  const after = await cdpIndexedSlugs(payTo);
  console.log(`\npayTo ${payTo}: ${after.total} indexed in CDP merchant (after)`);
  // emit machine-readable tail for the caller / report
  console.log("RESULT " + JSON.stringify({ payTo, before: before.total, after: after.total, settled: settled.length, failed: failed.length, failedSlugs: failed.map((f) => f.slug) }));
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
