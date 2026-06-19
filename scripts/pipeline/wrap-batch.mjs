#!/usr/bin/env node
/**
 * wrap-batch.mjs — the repeatable mass-wrap pipeline.
 *
 * INPUT  : a batch JSON file = an array of discovery-map rows. Each row
 *          declares one upstream endpoint (API + url + params + price +
 *          marketing copy + samples) in a friendly authoring format.
 * OUTPUT : three artifacts, all derived from that single source:
 *   1. apps/proxy/src/handlers/declarative/specs.<batch>.ts
 *        -> the DeclarativeSpec[] the engine registers (handler).
 *   2. scripts/seed/insert-<batch>.sql
 *        -> seller_proxy_configs + catalog_listings upserts
 *           (proxy config + pricing + bazaar/catalog registration).
 *   3. scripts/pipeline/manifest-<batch>.json
 *        -> {slug, priceUsdc, sampleRequest} rows for the live-settle
 *           smoke harness.
 * input_schema is produced at runtime by engine.makeDeclarativeInputSchema
 * from the same `params`, so it is never hand-maintained.
 *
 * Usage:  node scripts/pipeline/wrap-batch.mjs <batchFile.json> <batchId>
 *
 * This is intentionally dependency-free (no TS, no build step) so it can
 * run as the first stage of a 100/day loop. Validation is strict: a row
 * that would produce an unsafe SQL string or an over-long bazaar
 * description aborts the whole batch (fail loud, never half-wrap).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..");

// Reused, proven payment config (macro seed — already settling live).
const RESOURCE_KEY = "reskey_1166628d";
// EVM payTo is read from the rotation pool registry so each batch lands
// on the currently-active service merchant address. CDP indexing showed
// no HARD per-payTo cap up to 133 endpoints, but indexing latency grows
// and we won't assume an infinite ceiling at 100/day — so we rotate.
// `activePayTo` is advanced by rotate-payto.mjs (DB-aware) when a payTo
// nears its soft cap. Falls back to the original merchant if no pool.
const POOL_PATH = "/etc/suverse-pay/payto-pool.json";
const ORIGINAL_PAY_TO_EVM = "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0";
function activeEvmPayTo() {
  try {
    const pool = JSON.parse(readFileSync(POOL_PATH, "utf8"));
    return pool.activePayTo || ORIGINAL_PAY_TO_EVM;
  } catch {
    return ORIGINAL_PAY_TO_EVM;
  }
}
const PAY_TO_EVM = activeEvmPayTo();
const PAY_TO_SOLANA = "CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM";
const PAY_TO_COSMOS = "noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj";
const NET_CONFIG = ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "cosmos:noble-1"];
const NET_CATALOG = ["eip155:8453", "solana:mainnet", "cosmos:noble-1"];

const [, , batchFileArg, batchIdArg] = process.argv;
if (!batchFileArg || !batchIdArg) {
  console.error("usage: wrap-batch.mjs <batchFile.json> <batchId>");
  process.exit(2);
}
const rows = JSON.parse(readFileSync(resolve(process.cwd(), batchFileArg), "utf8"));

const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sqlJson = (o) => sqlStr(JSON.stringify(o));
const sqlArr = (a) => `ARRAY[${a.map(sqlStr).join(",")}]`;
const handlerName = (slug) => slug.replace(/-/g, "_");

const errors = [];
const specs = [];
const manifest = [];
const sqlBlocks = [];
const seenSlugs = new Set();

for (const [i, r] of rows.entries()) {
  const where = `row ${i} (${r.slug ?? "<no slug>"})`;
  const need = (c, m) => { if (!c) errors.push(`${where}: ${m}`); };
  need(r.slug && /^[a-z0-9-]{3,50}$/.test(r.slug), "slug must be 3..50 [a-z0-9-]");
  need(!seenSlugs.has(r.slug), "duplicate slug in batch");
  seenSlugs.add(r.slug);
  need(r.title, "title required");
  need(r.description, "description required");
  need(r.descriptionBazaar && r.descriptionBazaar.length <= 320, "descriptionBazaar required and <=320 chars");
  need(Number.isInteger(r.priceUsdcAtomic) && r.priceUsdcAtomic >= 1000 && r.priceUsdcAtomic <= 10000000, "priceUsdcAtomic in 1000..10000000");
  need(Array.isArray(r.tags) && r.tags.length > 0, "tags[] required");
  need(r.upstream && r.upstream.url, "upstream.url required");
  need(r.params && typeof r.params === "object", "params object required");
  need(r.sampleRequest && typeof r.sampleRequest === "object", "sampleRequest required");
  need(r.sampleResponse && typeof r.sampleResponse === "object", "sampleResponse required");
  // ASCII-only marketing copy (matches existing seeds; avoids CDP unicode trips).
  for (const [k, v] of [["description", r.description], ["descriptionBazaar", r.descriptionBazaar], ["title", r.title]])
    need(/^[\x20-\x7E]*$/.test(v ?? ""), `${k} must be ASCII-only`);
  if (errors.length) continue;

  const hname = handlerName(r.slug);

  // --- 1. DeclarativeSpec ---
  specs.push({
    handlerName: hname,
    slug: r.slug,
    category: r.category,
    sourceLabel: r.source ?? r.category,
    upstreamMethod: "GET",
    urlTemplate: r.upstream.url,
    headers: r.upstream.headers ?? undefined,
    timeoutMs: r.upstream.timeoutMs ?? undefined,
    params: r.params,
    staticQuery: r.upstream.staticQuery ?? undefined,
    pick: r.pick ?? undefined,
  });

  // --- 2. SQL upsert (config + catalog) ---
  const url = `https://proxy.suverse.io/v1/data/${r.slug}`;
  sqlBlocks.push(`-- ${r.category} :: ${r.slug} ($${(r.priceUsdcAtomic / 1e6).toFixed(3)})
WITH proxy_ins AS (
  INSERT INTO seller_proxy_configs (
    id, resource_key_id, endpoint_slug, public_slug, original_url, original_method,
    display_name, description, description_bazaar, price_atomic, accepted_networks,
    pay_to_evm, pay_to_solana, pay_to_cosmos, forward_auth_scheme, is_active,
    upstream_x402_enabled, internal_handler
  ) VALUES (
    gen_random_uuid(), '${RESOURCE_KEY}', ${sqlStr(r.slug)}, ${sqlStr(r.slug)}, ${sqlStr(url)}, 'POST',
    ${sqlStr(r.title)}, ${sqlStr(r.description)}, ${sqlStr(r.descriptionBazaar)}, ${r.priceUsdcAtomic}, ${sqlArr(NET_CONFIG)},
    '${PAY_TO_EVM}', '${PAY_TO_SOLANA}', '${PAY_TO_COSMOS}', 'static', true,
    false, ${sqlStr(hname)}
  )
  ON CONFLICT (resource_key_id, endpoint_slug) DO UPDATE
    SET internal_handler = EXCLUDED.internal_handler, public_slug = EXCLUDED.public_slug,
        display_name = EXCLUDED.display_name, description = EXCLUDED.description,
        description_bazaar = EXCLUDED.description_bazaar, price_atomic = EXCLUDED.price_atomic,
        accepted_networks = EXCLUDED.accepted_networks, pay_to_evm = EXCLUDED.pay_to_evm,
        pay_to_solana = EXCLUDED.pay_to_solana, pay_to_cosmos = EXCLUDED.pay_to_cosmos,
        is_active = true, updated_at = now()
  RETURNING id, resource_key_id
)
INSERT INTO catalog_listings (
  id, title, description, endpoint_url, tags, price_atomic_min, price_atomic_max,
  price_unit, networks, status, resource_key_id, slug, category,
  sample_request_json, sample_response_json, description_bazaar, proxy_config_id
)
SELECT
  gen_random_uuid(), ${sqlStr(r.title)}, ${sqlStr(r.description)}, ${sqlStr(url)},
  ${sqlArr(r.tags)}, ${r.priceUsdcAtomic}, ${r.priceUsdcAtomic}, 'per-call', ${sqlArr(NET_CATALOG)},
  'approved', proxy_ins.resource_key_id, ${sqlStr(r.slug)}, ${sqlStr(r.category)},
  ${sqlJson(r.sampleRequest)}, ${sqlJson(r.sampleResponse)}, ${sqlStr(r.descriptionBazaar)}, proxy_ins.id
FROM proxy_ins
ON CONFLICT DO NOTHING;`);

  // --- 3. manifest row for the smoke harness ---
  manifest.push({
    slug: r.slug,
    priceUsdc: (r.priceUsdcAtomic / 1e6).toFixed(6),
    category: r.category,
    sampleRequest: r.sampleRequest,
  });
}

if (errors.length) {
  console.error(`BATCH ABORTED — ${errors.length} validation error(s):`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}

// Emit specs TS
const specsTs = `/**
 * GENERATED by scripts/pipeline/wrap-batch.mjs from batch "${batchIdArg}".
 * Do not hand-edit — re-run the pipeline. ${specs.length} endpoints.
 */
import type { DeclarativeSpec } from "./types.js";

export const SPECS_${batchIdArg.toUpperCase().replace(/[^A-Z0-9]/g, "_")}: DeclarativeSpec[] = ${JSON.stringify(specs, null, 2)};
`;
const specsPath = resolve(REPO, `apps/proxy/src/handlers/declarative/specs.${batchIdArg}.ts`);
writeFileSync(specsPath, specsTs);

const sqlPath = resolve(REPO, `scripts/seed/insert-${batchIdArg}.sql`);
writeFileSync(
  sqlPath,
  `-- GENERATED by wrap-batch.mjs — batch ${batchIdArg} — ${specs.length} endpoints.\n-- Idempotent (UPSERT). Reuses reskey ${RESOURCE_KEY} + proven payTo trio.\nBEGIN;\n\n${sqlBlocks.join("\n\n")}\n\nCOMMIT;\n`,
);

const manifestPath = resolve(REPO, `scripts/pipeline/manifest-${batchIdArg}.json`);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// Bake the deploy + per-endpoint indexing settle into the pipeline. CDP
// only indexes an endpoint AFTER a Base settle hits it, so EVERY endpoint
// this batch creates gets exactly one indexing settle (index-batch.mjs
// fires one per slug in the manifest — not a sample). Without this step a
// batch lands live-but-invisible.
const deployPath = resolve(REPO, `scripts/pipeline/deploy-${batchIdArg}.sh`);
writeFileSync(
  deployPath,
  `#!/usr/bin/env bash
# GENERATED by wrap-batch.mjs — deploy + auto-index for batch ${batchIdArg}.
# Run after author -> probe -> wrap-batch. This is the step that makes the
# batch DISCOVERABLE: it settles every endpoint once so CDP Bazaar indexes it.
set -euo pipefail
REPO="${REPO}"
DB="$(grep -hoP '^DATABASE_URL=\\K.*' /etc/suverse-pay/proxy.env | tr -d '"')"
echo "1/4 dry-run seed (rollback)"; sed 's/^COMMIT;/ROLLBACK;/' "$REPO/scripts/seed/insert-${batchIdArg}.sql" | psql "$DB" -v ON_ERROR_STOP=1 -q
echo "2/4 apply seed";            psql "$DB" -v ON_ERROR_STOP=1 -q -f "$REPO/scripts/seed/insert-${batchIdArg}.sql"
echo "3/4 restart proxy";         kill "$(systemctl show -p MainPID --value suverse-pay-proxy.service)"; sleep 6
echo "4/4 per-endpoint indexing settle (auto)"
PAYER_BASE_PRIVATE_KEY_PATH=\${PAYER_BASE_PRIVATE_KEY_PATH:-/etc/suverse-pay/base-payer.key} \\
  node "$REPO/apps/proxy/scripts/index-batch.mjs" --batch ${batchIdArg} --delay 3000 --poll
`,
  { mode: 0o755 },
);

console.log(`OK: ${specs.length} endpoints wrapped for batch ${batchIdArg} (payTo ${PAY_TO_EVM})`);
console.log(`  specs:    ${specsPath}`);
console.log(`  seed sql: ${sqlPath}`);
console.log(`  manifest: ${manifestPath}`);
console.log(`  deploy:   ${deployPath}   <-- REQUIRED: seeds + restarts + auto-indexes EVERY endpoint`);
console.log(`NEXT: bash ${deployPath}`);
