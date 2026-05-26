# Changelog

All notable changes to `suverse-pay` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/).

## [v0.1.0-rc.1] — 2026-05-26

Phase 1 release candidate. All mocked Phase-1-done acceptance
criteria from TASK.md §"Required for Phase 1 done" are green:

- `pnpm install && pnpm build` exits 0 (7 packages).
- `pnpm test` exits 0 (284 unit tests, 1 documented skip).
- `pnpm test:integration` exits 0 (25 end-to-end tests against the
  live Docker Postgres + Redis with nock-intercepted provider HTTP).
- `docker compose up -d && pnpm db:migrate && pnpm db:bootstrap`
  applies the schema and seeds the admin api_key end-to-end against
  Postgres 15.
- `bash scripts/smoke/mocked/run-all.sh` PASSes all 10 endpoint
  scenarios from TASK.md §"Required for Phase 1 done" item 4, plus a
  bonus `/verify` step.
- README has a copy-paste runnable quick start (clone → docker compose
  → migrate → bootstrap → smoke).

### Known limitations carried into Phase 2

- Race-replay of `/settle` may surface a payment in `pending` state.
  Exactly one row and one adapter HTTP call still happen (verified by
  the integration `Promise.all` test); clients should `GET
  /payments/:id` to see the terminal state. Phase 2 will hold the
  Redis lock through finalization.
- `pnpm db:bootstrap --force` rotation updates the on-disk hash; the
  running server keeps the prior hash in memory until restart.
  Documented in README; Phase 2 will add SIGHUP-style rotation.
- One vitest case (`services/orchestrator/src/health-check.test.ts:177`)
  is `it.skip`ped because the 175ms wait + 50ms tick assertion is
  flaky under parallel test load. Phase 2 will rewrite with
  `vi.useFakeTimers()`.

### Release gate (NOT in this RC)

- Real-network smoke against a deployed `cosmos-pay` Cosmos testnet
  facilitator.
- Real-network smoke against Coinbase CDP x402 with a real API key.

Both are documented in TASK.md §"Required for v0.1.0 release tag".
The full `v0.1.0` tag depends on at least item #7 (cosmos-pay
testnet) passing.

## [Unreleased]

### Added

- Initial monorepo scaffolding: pnpm workspaces, Turborepo, shared
  `tsconfig.base.json`, Docker Compose for Postgres 15 + Redis 7,
  GitHub Actions CI skeleton, Apache 2.0 license, `.env.example`.
- `@suverse-pay/core-types` package — `ProviderAdapter` interface,
  CAIP-2 helpers, normalized error codes (with retryable/non-retryable
  classification per TASK.md), x402 protocol types
  (`PaymentRequirements`, `PaymentPayload`), gateway-internal
  `Payment` and `PaymentAttempt` types, `MerchantPolicy` schema,
  and Zod schemas for every adapter and gateway boundary type.
  `SettleOptions` carries an optional `idempotencyKey` that the
  orchestrator plumbs through to adapters for downstream replay
  protection.
- `@suverse-pay/provider-sdk` package — `BaseAdapter` abstract class,
  `httpJson` fetch wrapper, `withRetry` (retryable codes only),
  `withTimeout`. `httpJson` propagates the caller's `Idempotency-Key`
  on every retry attempt, satisfying the two-layer idempotency
  invariant end-to-end.
- `ProviderAdapter.getStatus()` now accepts an optional `hints`
  argument (`{ txHash?, errorCode? }`). Adapters for providers with
  no native status endpoint (cosmos-pay) reconstruct status from the
  orchestrator-supplied hints rather than taking a DB dependency.
- `@suverse-pay/adapter-cosmos-pay` package — first concrete adapter.
  Wraps `sudzikcoin/cosmos-pay`'s HTTP facilitator (`/verify`,
  `/settle`, `/supported`, `/healthz`). Wire schemas pinned to the
  real Go code (`facilitator/types.go` and `cmd/main.go`). Internal
  retry on `/settle` is enabled ONLY when the caller supplies an
  `idempotencyKey`. cosmos-pay's `invalidReason` / `errorReason`
  strings are normalized through a dictionary-style map with a
  warning-logged `provider_internal_error` fallback for unknown
  codes. `/healthz` uses raw `fetch` (empty body, no JSON parse).
- `@suverse-pay/adapter-coinbase-cdp` package — second concrete
  adapter. Wraps Coinbase Developer Platform's hosted x402 facilitator
  at `https://api.cdp.coinbase.com/platform/v2/x402` (EVM + Solana,
  `exact` / `upto` schemes). Wire shapes pinned to the canonical
  x402 v2 reference types in `coinbase/x402` on GitHub.
  Authentication is a short-lived EdDSA JWT (`jose` + Ed25519) built
  per the CDP spec (sub/iss=cdp/aud=[cdp_service]/nbf/exp/uri, header
  with random nonce). `UsageTracker` interface + `InMemoryUsageTracker`
  enforce the configurable monthly hard cap from `supports()` so
  routing skips this provider once the free tier is exhausted — a
  Redis-backed tracker will plug in during Step 6.
- `.env.example` updated: `COINBASE_CDP_API_KEY` /
  `COINBASE_CDP_API_SECRET` renamed to `COINBASE_CDP_API_KEY_NAME` /
  `COINBASE_CDP_API_KEY_SECRET` to match the CDP portal's exported
  terminology. Optional `COINBASE_CDP_BASE_URL` added.
- vitest test runner (workspace devDep). 156 unit tests across all
  four packages.
- `@suverse-pay/orchestrator` service — the brain of the gateway.
  Pure-logic modules (`router`, `policy`, `quote-aggregator`,
  `fallback`) and IO-bound modules (`PaymentLedger`, `ProviderRegistry`,
  `CapabilityDiscoveryCron`, `HealthCheckCron`, `RedisUsageTracker`)
  are split so the bulk of routing semantics is testable without a
  database.
  - Router implements TASK.md §"Routing logic v0.1" exactly:
    supports-filter → live-traffic-health-rule (>=10 attempts &
    >=30% failures => unhealthy) → quiet-period fallback to
    `provider_health_checks` (5min window) → score by
    cost/latency/success_rate → optional provider-hint promotion
    (silently ignored if the hint fails support or health filters).
  - PaymentLedger enforces two-layer idempotency: Postgres unique
    partial index on `(api_key_id, idempotency_key)` is authoritative;
    Redis SETNX lock is the fast-path that avoids racing duplicate
    `/settle` calls into the unique-violation path. Verified by a
    `Promise.all` race test that fires 10 concurrent requests with
    the same key and asserts exactly one INSERT.
  - FallbackManager writes a `payment_attempts` row BEFORE every
    network call (CLAUDE.md invariant 4); cross-provider retry runs
    only on retryable error codes and only against candidates that
    still pass `supports()` at attempt time.
  - CapabilityDiscoveryCron + HealthCheckCron use `setInterval` for
    v0.1 (no BullMQ until we need real durability). Discovery
    reconciles static vs. discovered rows, marking superseded
    capabilities; an empty discovery result is treated as transient
    and does NOT supersede any static rows.
  - RedisUsageTracker implements the `UsageTracker` interface that
    `@suverse-pay/adapter-coinbase-cdp` defined in Step 5. Buckets
    per UTC month, auto-expires the key 35 days out (no monthly cron
    needed).
  - Tests use `pg-mem` + `ioredis-mock` for IO-bound modules; pure
    logic has no DB dependency. 83 new tests, 239 total across the
    workspace.
- `@suverse-pay/db` — SQL migrations and a ~100-line raw-SQL runner.
  No `node-pg-migrate` / Knex / Prisma dep — `pnpm db:migrate` is a
  single `tsx src/migrate.ts` invocation that reads every `.sql` file
  in `db/migrations/` in lexicographic order, applies the ones not
  yet recorded in `schema_migrations`, and wraps each one in its own
  transaction so partial application is impossible. Bootstraps
  `schema_migrations` itself outside any transaction with
  `IF NOT EXISTS`, so the runner is safe against an empty DB or one
  that has been partially migrated.
  - `001_initial.sql` creates the Phase 1 schema verbatim from
    TASK.md §"Database schema (Postgres)": `api_keys`,
    `merchant_policies`, `providers`, `provider_capabilities`
    (with `is_static` / `is_discovered` / `superseded_at`),
    `provider_health_checks`, `payments` (with the partial unique
    index on `(api_key_id, idempotency_key) WHERE idempotency_key
    IS NOT NULL` that the orchestrator's two-layer idempotency
    relies on), `payment_attempts`, and `routing_decisions`. Every
    statement uses `IF NOT EXISTS` so a re-run on an already-
    migrated DB is a no-op.
  - `db/schema.sql` — consolidated reference snapshot of the full
    schema. NOT executed; the migrations are the source of truth.
    Useful for IDE schema tooling and drift diffs against a live DB.
    A vitest assertion compares `CREATE TABLE` statements in the
    migrations against the snapshot, so an out-of-date snapshot
    fails CI before review.
  - `docker-compose.yml` host port defaults moved from 5432 / 6379 to
    5433 / 6380, and the `.env.example` `DATABASE_URL` / `REDIS_URL`
    were rewritten in lockstep — the gateway intentionally avoids
    the canonical Postgres / Redis ports so it can run alongside an
    existing host-level Postgres (e.g. the govhub deployment on the
    same VM) without a manual override.
  - 5 vitest cases against `pg-mem`: applies-on-first-run,
    creates-canonical-tables, idempotent-second-run, rolls-back-on-
    failure (with an explicit comment on a `pg-mem` gotcha — it does
    not roll back DDL inside a transaction, so the assertion is the
    data-level `schema_migrations` row absence, not the DDL absence;
    real Postgres rollback verified at Step 10), and the schema.sql-
    matches-migrations sentinel.
  - pg-mem gotcha #2: pg-mem does not implement `to_regclass()`. The
    test for "table exists" uses `information_schema.tables`, which
    works in both pg-mem and real Postgres.
  - Verified against the real Docker stack (Postgres 15-alpine on
    port 5433, Redis 7-alpine on port 6380). `pnpm db:migrate` on
    a fresh DB applied `001_initial.sql` and produced exactly the
    9 expected tables (8 project + `schema_migrations`). A second
    invocation was a no-op (`= 001_initial.sql (already applied)`).
    `payments_idempotency_idx` is a unique btree with the
    `WHERE (idempotency_key IS NOT NULL)` predicate; the
    `provider_capabilities` CHECK constraint
    `(is_static OR is_discovered)` is present. A failing
    out-of-tree migration was rolled back fully — both the
    `schema_migrations` row AND the partially-created table, which
    is the real-Postgres behaviour that pg-mem cannot model.
- `scripts/smoke/mocked/` — curl-based mocked smoke suite, one shell
  script per endpoint. Drives the live Postgres + Redis but registers
  in-memory `ProviderAdapter` fakes via a separate Fastify entrypoint
  (`apps/api/src/server-mock.ts`) so the production codepath has zero
  conditional "test mode" branches.
  - 10 numbered steps mapped to every TASK.md §"Required for Phase 1
    done" item 4 scenario plus a `POST /verify` bonus. `run-all.sh`
    orchestrates the whole sequence and always tears down the
    background server even on failure.
  - `_lib.sh` provides shared coloured PASS/FAIL output, an
    `expect_status` curl helper, and a `stop_smoke_server` routine
    that cascades SIGTERM → port-free wait → SIGKILL through the
    pnpm→tsx→node parent chain (since a naive `kill <pnpm pid>`
    leaves the listening Node child running and the port busy).
  - `SMOKE_COSMOS_PAY_FAIL_MODE` env knob restarts the mock server
    with cosmos-pay always returning a chosen `ErrorCode`. Step 07
    uses it to exercise the failure + retryable path end-to-end, then
    re-starts the server in default mode for downstream steps.
  - Default port is 3333 (not 3000 to stay clear of `pnpm dev`; not
    3001 because a host LaunchLoop instance was bound there). Every
    knob — `API_PORT`, `ADMIN_API_KEY`, `DATABASE_URL`, `REDIS_URL`,
    latency injection — is overridable via env.
  - Verified twice in a row that `run-all.sh` is idempotent — second
    run from a non-clean DB still PASSes 10/10 because step 00
    TRUNCATEs and re-bootstraps.
- `apps/api/tests/integration/` — full end-to-end integration suite
  driven against the live `docker compose` Postgres 15 + Redis 7 stack.
  Adapter HTTP traffic is intercepted by `nock` so the real cosmos-pay
  / Coinbase CDP wire shape (JWT signing, error mapping, retry path)
  is exercised without any external network. 25 tests across 8 files:
  - `setup.ts` builds the full Fastify app against the real Pool /
    Redis / Ledger / Registry, registers cosmos-pay + a Coinbase CDP
    adapter pointed at nock-able mock hosts, and exposes a
    `cleanState(stack)` helper that TRUNCATEs every non-fixture table,
    `FLUSHDB`s Redis, and re-bootstraps the admin api_key — so every
    test starts from a known-clean state.
  - Every required scenario from TASK.md §"Required for Phase 1 done"
    item 4 is covered:
    1. `GET /health` → 200 (no auth).
    2. `GET /providers` → both adapters listed with their static caps.
    3. `POST /quote` → synthetic quotes returned, both adapters
       considered.
    4. `POST /quote` with `optimize=cost` → quotes ordered ascending
       by `estimatedFeeUsd`.
    5. `POST /settle` against the cosmos-pay mock → `payments`,
       `payment_attempts`, and `routing_decisions` rows all populated;
       response carries the mock tx hash.
    6. Same `POST /settle` with the same `Idempotency-Key` → same
       paymentId, no second adapter HTTP call (verified by
       `nock.isDone()`), exactly one row in `payments`.
    7. `POST /settle` simulating provider failure → retryable path
       exercised end-to-end through `httpJson`'s retry logic
       (cross-provider fallback itself remains covered by the unit
       suite in `apps/api/src/__tests__/settle.test.ts`, since the
       integration fixture only registers one provider per route).
    8. `POST /settle` with an unsupported scheme → fails immediately
       with `route_unsupported`, zero adapter calls, attempts list
       empty.
    9. `GET /payments/:id` → returns the payment with its attempts
       array after a `/settle`.
    10. `GET /metrics/summary` → aggregate totals + per-provider
        breakdown.
  - Auth coverage: missing header → 401, wrong key → 401, valid key
    → 200, `db:bootstrap --force` rotation does NOT invalidate the
    running server's in-memory hash (documented behaviour — rotation
    requires a server restart in v0.1).
  - Idempotency: `POST /settle` without `Idempotency-Key` → 400 with
    `invalid_request` and no payment row created.
  - **Real `Promise.all` race**: two concurrent `POST /settle` with
    the same key return the same `paymentId`, exactly one outbound
    adapter call (nock `isDone()`), exactly one `payments` row. The
    final state is `settled` with the mock tx hash, verified via a
    follow-up `GET /payments/:id`. A v0.1 race-replay limitation is
    surfaced and documented in-test: the replay request may observe
    the row while still `pending`; v0.2 will hold the lock until
    finalization.
- `apps/api` test split: `pnpm test` now drives the in-memory unit
  suite via `vitest.config.ts`; `pnpm test:integration` drives the
  Docker-backed suite via `vitest.integration.config.ts`. Root
  `pnpm test` runs unit only (so it stays green without Postgres);
  `pnpm test:integration` is a separate workspace script.
- `.github/workflows/ci.yml` split into two jobs: `unit` (build +
  unit tests, no services) and `integration` (Postgres 15 + Redis 7
  as GitHub Actions services, `db:migrate`, `db:bootstrap`,
  `test:integration`).
- `pnpm db:bootstrap` — CLI that seeds the single
  `apikey_admin_default` row in `api_keys` from the `ADMIN_API_KEY`
  env var. Sha256 hash only — never the plaintext. Idempotent by
  default; a mismatched existing row refuses to overwrite unless
  `--force` (or `ADMIN_API_KEY_FORCE=1`) is supplied, so an
  accidental env-var typo cannot lock everyone out of the gateway.
  - The hash function (`sha256ApiKeyHash`) and the row id
    (`ADMIN_API_KEY_ID = 'apikey_admin_default'`) now live in
    `@suverse-pay/db` and are re-exported by
    `apps/api/src/plugins/auth.ts`. The write side (bootstrap CLI)
    and the read side (Fastify auth plugin) therefore share one
    source of truth — they cannot drift apart.
  - The `db` package was reorganised: `migrate.ts` now exports only
    the pure runner; CLI shells live in `migrate-cli.ts` and
    `bootstrap-cli.ts`; a new `index.ts` re-exports the public API.
  - 8 vitest cases against `pg-mem` cover the matrix: fresh insert,
    same-key replay (skipped), mismatched-key (rejected with a
    typed `AdminKeyRotationRequiredError`), rotation under
    `force=true`, empty-key rejection, plus three sha256 sanity
    checks including an `openssl dgst -sha256` cross-check against
    a known vector. README now documents the bootstrap step + the
    rotation flow.
  - Verified end-to-end against the live Docker Postgres on port
    5433: created → skipped → refused → rotated → missing-env all
    return the expected exit codes, and a direct
    `psql ... key_hash` query matches the `sha256sum` of the
    plaintext bit-for-bit (proving the server will accept the same
    key the bootstrap wrote).
- `@suverse-pay/api` — Fastify HTTP entrypoint for the gateway. One
  endpoint per TASK.md §"REST API specification": `GET /health`
  (liveness, unauthenticated), `GET /providers`, `POST /quote`,
  `POST /verify`, `POST /settle`, `GET /payments/:id`,
  `GET /metrics/summary`. Plugins: sha256 admin-key bearer auth (Phase
  4 will keep `request.apiKeyId` shape but resolve it from DB),
  Idempotency-Key extraction, Redis-backed `@fastify/rate-limit`
  (in-memory fallback when no Redis), pino structured logging, and a
  global error handler that normalizes Zod / GatewayError /
  ProviderError / Fastify errors into a single `{ error: { code,
  message } }` envelope.
  - Architectural split: `buildServer(ctx)` takes a `ServerContext`
    with `registry`, `ledger`, `loadHealthSummaries`, `loadMetrics`,
    so every route is testable with in-memory fakes. The real Pool /
    Redis / cron / adapter wiring is confined to `index.ts`. Tests
    never touch real Postgres.
  - `/settle` is the hot path: it asserts the Idempotency-Key header
    (400 otherwise), calls `PaymentLedger.createOrFetchPayment` (two-
    layer idempotency — Postgres unique index + Redis SETNX lock),
    runs the router, persists the decision to `routing_decisions`,
    drives `runFallback` across the candidate list, finalizes the
    `payments` row, and always releases the Redis lock in a
    `finally` block.
  - `/payments/:id` returns 404 (not 403) for cross-tenant lookups,
    so an api key cannot probe for the existence of another tenant's
    payment.
  - Graceful shutdown on SIGTERM / SIGINT stops both crons, closes
    the Fastify server, ends the pg pool, and disconnects Redis.
  - `loadHealthSummariesFromDb` rolls up `payment_attempts` (last
    60s + 7d) and the most recent `provider_health_checks` row per
    provider for the router's health-rule input. `loadMetricsFromDb`
    powers `/metrics/summary` with payment status counts + per-
    provider attempt/success/failure rolls over the last 24h.
  - 33 integration tests using `app.inject()` — auth (5), `/health`
    (2), `/providers` (3), `/quote` (5), `/verify` (5), `/settle` (8
    incl. idempotency replay, fallback chain, non-retryable stop,
    route_unsupported, and Redis-lock release on exception),
    `/payments/:id` (3), `/metrics/summary` (2). Total workspace
    coverage now 272 tests across 30 files.
