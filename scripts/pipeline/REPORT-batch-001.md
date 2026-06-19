# Batch Wrap Pipeline + Batch 001 — Proof Report

**Date:** 2026-06-19 · **Repo:** suverse-pay · **Status:** pipeline LIVE, batch-001 (24 endpoints) LIVE on `proxy.suverse.io/v1/data/*`, 4 live Base settles.

Goal restated: don't hand-wrap 700 endpoints one-off. Build a **repeatable generator** that turns one discovery-map row (API + endpoint + params) into a deployed paid x402 endpoint — proxy config + input_schema + pricing + bazaar/catalog registration — then prove it by pushing the first ~24 starred free-to-wrap endpoints through it and settling live.

---

## 1. The pipeline (how 100/day works without 100 hand-written handlers)

The existing codebase wraps each endpoint as a bespoke TypeScript `internal_handler` (e.g. `sec-filings.ts`, `frankfurter-rates-batch.ts`) + a SQL config row. That's ~80 lines of TS per endpoint — does not scale to 700.

The pipeline collapses the **TS-per-endpoint** cost to **data-per-endpoint** by introducing one generic, data-driven handler:

```
discovery-map row (JSON)
        │   scripts/pipeline/wrap-batch.mjs   (the generator)
        ├─────────────► specs.<batch>.ts        DeclarativeSpec[]  (handler data)
        ├─────────────► insert-<batch>.sql      seller_proxy_configs + catalog_listings upserts
        └─────────────► manifest-<batch>.json   {slug, price, sampleRequest} for the smoke harness

apps/proxy/src/handlers/declarative/engine.ts  (the generic engine, written ONCE)
   makeDeclarativeHandler(spec)     -> InternalHandler   (parse body → GET upstream → map errors → shape)
   makeDeclarativeValidator(spec)   -> pre-pay 422 gate on present-but-invalid input (discovery-safe)
   makeDeclarativePreflight(spec)   -> fail-closed: never settle on a missing/invalid required field
   makeDeclarativeInputSchema(spec) -> machine-readable contract on the 402 challenge

handlers/registry.ts  (one loop registers every spec into the 4 registries; collisions throw loudly)
```

**Adding 100 endpoints/day = appending 100 JSON rows + re-running `wrap-batch.mjs` + `pnpm build` + seed + restart.** Zero new functions. `input_schema` is derived from the same `params`, so it is never hand-maintained.

### What a discovery-map row looks like (the only thing a human/agent authors)
```jsonc
{
  "slug": "suverse-weather-current",
  "category": "weather",
  "source": "open-meteo",
  "title": "Current Weather Conditions",
  "description": "…ASCII, keyword-dense…",
  "descriptionBazaar": "…<=320 chars for CDP…",
  "tags": ["weather","current","temperature","wind","meteorology"],
  "priceUsdcAtomic": 3000,
  "upstream": { "url": "https://api.open-meteo.com/v1/forecast",
                "staticQuery": {"current_weather":"true"}, "headers": {} },
  "params": {
    "latitude":  {"in":"query","required":true,"type":"number","description":"…","example":40.71},
    "longitude": {"in":"query","required":true,"type":"number","description":"…","example":-74.01}
  },
  "sampleRequest":  {"latitude":40.71,"longitude":-74.01},
  "sampleResponse": {"source":"open-meteo","data":{"current_weather":{"temperature":21.3}}}
}
```

### Engine capabilities (covers the no-auth public-data firehose)
- **Path templating** `{field}` + **query params** + always-on `staticQuery`.
- **Transforms**: `upper`, `lower`, `csv` (array→comma), `pad10` (SEC CIK zero-pad), `identity`.
- **upstreamName** aliasing (body `cve_id` → upstream `cveId`; body `team` → `t`).
- **Validation**: per-param `type` / `pattern` / `enum` / `required` / `default`.
- **Error mapping** (matches existing handlers): 429→503, upstream 4xx→400, !ok→502, timeout→504, bad-json→502.
- **Response shaping**: `{source, data}` envelope + optional top-level `pick` projection.
- **Discovery-safe gating** (mirrors `handlers/discovery.ts`): empty/placeholder body → 402 challenge (crawlers read price + schema); present-but-invalid → 422 *before* payment; paid request with a missing required field → preflight blocks settlement (no pay-for-garbage).

**Scope limit (honest):** the engine models **single-hop GET, no-auth/free-key** upstreams. Multi-hop (NWS points→forecast), POST upstreams, OAuth, and CSV-parsing upstreams still get a bespoke handler. That single-hop slice is exactly the free-to-wrap public-data firehose, which is where the 700-endpoint volume lives.

---

## 2. Batch 001 — 24 starred free-to-wrap endpoints (LIVE)

All under `https://proxy.suverse.io/v1/data/<slug>`, POST, priced $0.002–$0.009, accepting Base + Solana + Cosmos Noble, `status=approved` in `catalog_listings` (so the CDP Bazaar crawler indexes them and the proxy emits `extensions.bazaar`).

| Category | Endpoints | Upstream (auth) |
|----------|-----------|------------------|
| Treasury yields | avg-rates, debt-to-penny, exchange-rates | Treasury FiscalData (no-key, UA) |
| Macro (FRED substitute) | macro-indicator, macro-gdp, cpi-inflation, unemployment | World Bank Open Data (no-key) |
| SEC EDGAR | company-concept, company-facts, submissions | data.sec.gov (no-key, UA) |
| Weather stack | current, forecast, historical, air-quality, marine, alerts | Open-Meteo + NWS (no-key) |
| Cybersecurity / CVE | cve-lookup, cve-search, cisa-kev | NVD + CISA KEV (no-key) |
| Sports (odds substitute) | sports-team, league-table, events-day, mlb-schedule, mlb-standings | TheSportsDB + MLB StatsAPI (no-key) |

**Why these vs the literally-named starred set:** FRED and The Odds API both need a key whose ToS restricts redistribution → they are `needs-permission`, which you said to skip. I substituted the **free-to-wrap equivalents** in the same categories (World Bank for macro, TheSportsDB/MLB for sports) so the starred *categories* all ship now. FRED + Odds slot in later via the same pipeline the moment their keys/approvals land (just add rows with `headers`/key injection).

---

## 3. Live settle proof (real on-chain Base settlements)

Run via `scripts/test-batch-endpoints.mts` (reads the batch manifest, pays with the Base buyer wallet `0x3869dE…`):

| Endpoint | Price | Base tx hash | Result |
|----------|-------|--------------|--------|
| suverse-treasury-debt-to-penny | $0.005 | `0xb2c120d741f041ee4186a8bd3d00a3a85ecb7f020e935c064c8cab240ae8369f` | real Treasury debt JSON |
| suverse-weather-current | $0.003 | `0x438263fc3fe9fb69f0a9dbab3b84ffcc1765b27e1a9c75f279ff2a99d0852f15` | real Open-Meteo conditions |
| suverse-macro-gdp | $0.004 | `0x96fbc2ad3291afdc5a7be22324265e6d7ca2f5a465f0c3211cc4b773f37199e0` | real World Bank GDP series |
| suverse-sec-company-concept | $0.008 | `0xaf5652b15321d4142886e6f85a6c133414748293697cbc59be0f514f75eede53` | real SEC XBRL Revenues |

**4/4 settled, ~$0.02 total.** Protocol checks also confirmed: empty body → 402 + `input_schema` (required `["latitude","longitude"]`, 3 accepts); `{"country":"USA1"}` → 422 (validator fires pre-payment).

---

## 4. Tests & build
- `apps/proxy/tests/declarative-engine.test.ts` — 14 tests, all green (URL building incl. pad10/upper/pick, error mapping, validator discovery-vs-422, preflight fail-closed, input-schema shape).
- `pnpm --filter ./apps/proxy build` — clean (tsc).
- Full proxy suite: 705 pass / 1 fail — the 1 failure is the **pre-existing** token-check cohort-silence test (elite feed silent, unrelated to this change; file untouched).

---

## 5. Reliability notes (carry into scale-up)
- **Best-effort upstreams:** NVD (`services.nvd.nist.gov`) returned a 503 from this datacenter IP during testing — it rate-limits/blocks DC IPs without an API key. The 3 CVE endpoints are live but flagged best-effort; a paid call during an NVD outage maps to 502 (engine has no upstream-health preflight — see gap below). Provision a free NVD API key before promoting CVE to SLA-grade.
- **No upstream-health preflight:** the declarative preflight gates *input*, not upstream liveness. For flaky upstreams a buyer can pay then get 502. The aggregated endpoints (crypto-market-pulse etc.) solve this with a health preflight; a generic `healthCheckUrl` field on the spec is the natural next enhancement for flaky sources.
- **Treasury** needs a `User-Agent` (added) or returns empty. **NWS** `/alerts/active` rejects `limit` (removed). Both caught by pre-seed curl de-risking — fold a curl smoke step into the generator before scale-up.

---

## 6. Scale path to 100/day
1. Author the next 100 discovery-map rows (from REPORT.md master table; the free-to-wrap firehose: USGS quakes, NASA, openFDA, RxNorm, FiscalData siblings, more World Bank indicators, Frankfurter, Nager holidays, RDAP, NHTSA VIN, OpenAlex, Wikipedia…). Most are single-hop GET no-auth → fit the engine as-is.
2. `node scripts/pipeline/wrap-batch.mjs batch-002.json batch-002`
3. Add `import { SPECS_BATCH_002 }` + spread into `DECLARATIVE_SPECS` (one line); `pnpm build`.
4. Dry-run seed (`COMMIT`→`ROLLBACK`), apply, `kill MainPID` to restart proxy.
5. `ONLY=<2 slugs> tsx scripts/test-batch-endpoints.mts` to smoke a live settle.
Throughput is bound by authoring rows + curl de-risking, not engineering.

---

## Artifacts in this bundle
- `engine.ts`, `types.ts` — the generic declarative engine (durable core).
- `wrap-batch.mjs` — the generator.
- `batch-001-starred.json` — the 24 discovery-map rows (authored input).
- `specs.batch-001.ts` — generated handler data.
- `insert-batch-001.sql` — generated config + catalog/bazaar registration.
- `manifest-batch-001.json` — generated smoke-harness input.
- `declarative-engine.test.ts` — unit tests.
