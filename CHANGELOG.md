# Changelog

All notable changes to `suverse-pay` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/).

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
