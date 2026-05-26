# Mocked smoke tests

Curl-based end-to-end checks against the gateway running with in-memory
mock adapters. No external HTTP, no cosmos-pay or CDP credentials —
just `docker compose` + Node.

## What it proves

Every script maps to one (or two) of the ten required acceptance
scenarios from `TASK.md` §"Required for Phase 1 done" item 4:

| Step | Endpoint               | TASK.md scenario  |
|------|------------------------|-------------------|
| 01   | `GET /health`          | #1                |
| 02   | `GET /providers`       | #2                |
| 03   | `POST /quote`          | #3 + #4           |
| 04   | `POST /verify`         | (bonus)           |
| 05   | `POST /settle`         | #5                |
| 06   | replay `/settle`       | #6                |
| 07   | `/settle` failure path | #7 + #8           |
| 08   | `GET /payments/:id`    | #9                |
| 09   | `GET /metrics/summary` | #10               |

Step 11 (mocked smoke) is itself the same acceptance check applied
via shell + `curl` instead of vitest — so a human can copy-paste and
read the output, and so a follow-up developer doesn't need to run
the full test runner just to confirm the gateway still wires up.

## Prerequisites

```bash
# Postgres + Redis on host ports 5433 / 6380 (see docker-compose.yml).
docker compose up -d

# Apply migrations once per fresh DB.
pnpm db:migrate

# Bootstrap is also done by 00-setup.sh, but you can pre-run it.
ADMIN_API_KEY=smoke-test-admin-key pnpm db:bootstrap --force

# jq is required for output formatting.
which jq
```

## Run the whole suite

```bash
bash scripts/smoke/mocked/run-all.sh
```

`run-all.sh` runs `00-setup.sh` → `01-health.sh` → ... → `09-metrics.sh`,
prints PASS/FAIL per step, and always finishes with `99-teardown.sh`
(even on failure) so it does not leak a background server.

## Run a single step

```bash
# Boot the mock server first.
bash scripts/smoke/mocked/00-setup.sh

# Drive any individual step.
bash scripts/smoke/mocked/05-settle-happy.sh
bash scripts/smoke/mocked/06-settle-idempotent.sh

# Tear down when you're done.
bash scripts/smoke/mocked/99-teardown.sh
```

State that persists across steps (last paymentId, last idempotency
key) is kept in `/tmp/suverse-pay-smoke/`. Step 99 cleans it up.

## How the server is built

`apps/api/src/server-mock.ts` is a separate entrypoint from
`apps/api/src/index.ts`. It uses the same Fastify build path and the
same real Postgres + Redis, but registers two in-memory adapters
that return deterministic responses without opening a socket. Keeps
the production codepath conditional-free.

Knobs (set in the env before running setup):

- `API_PORT` (default 3333 — kept clear of prod 3000 and a host's
  LaunchLoop dev server on 3001)
- `ADMIN_API_KEY` (default `smoke-test-admin-key`)
- `DATABASE_URL` / `REDIS_URL` (default match `docker-compose.yml`
  ports 5433 / 6380)
- `SMOKE_COSMOS_PAY_FAIL_MODE` — set to any `ErrorCode` (e.g.
  `provider_internal_error`) to make the cosmos-pay mock return
  `settled=false` with that code. Used by `07-settle-fallback.sh`.
- `SMOKE_COSMOS_PAY_LATENCY_MS` / `SMOKE_CDP_LATENCY_MS` — inject a
  sleep before mock responses, useful when eyeballing routing
  decisions.

## Known v0.1 nuances surfaced by the suite

- The cross-provider fallback path is **not** exercised here because
  the smoke fixture only registers one provider per route
  (`cosmos-pay` for `exact_cosmos_authz`). When that provider is
  forced into fail-mode, the result is the same as an exhausted
  candidate list — `status=failed, errorCode=provider_internal_error`.
  Cross-provider routing is covered by the unit + integration suites
  in `apps/api/{__tests__,tests/integration}/settle.test.ts`.
- Race-replay of `/settle` may return a payment row that is still
  `pending`; documented as a v0.1 limitation in the integration
  suite. The smoke tests issue requests sequentially so they never
  hit this.

## Adding a new smoke step

1. Copy an existing step (e.g. `02-providers.sh`) to
   `NN-your-step.sh`. Keep the numeric prefix so `run-all.sh` orders
   it correctly.
2. Source `_lib.sh` for shared helpers (`pass`, `fail`,
   `expect_status`, colours, paths).
3. Add the new filename to the `steps=(...)` array in `run-all.sh`.
4. Update the table at the top of this README.
