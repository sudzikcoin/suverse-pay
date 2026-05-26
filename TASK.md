# TASK.md — suverse-pay Phase 1 implementation

## Goal

Build the Phase 1 MVP of suverse-pay: a unified REST API gateway over
two x402 facilitator providers (Coinbase CDP and our cosmos-pay), with
rule-based routing, fallback, idempotent settlement, and full payment
logging.

Out of scope for this task: MCP server (Phase 2), native facilitator
(Phase 5), merchant accounts with billing (Phase 4). Do not build them.

## Reading order

Before writing any code:

1. `CLAUDE.md` — architecture, conventions, invariants. Binding.
2. This file (`TASK.md`) — what to build.
3. `https://github.com/sudzikcoin/cosmos-pay` — the sister repo whose
   HTTP API we wrap as one of the two adapters. Read the README and
   `specs/scheme_exact_cosmos_authz.md`.
4. `https://docs.cdp.coinbase.com/x402/core-concepts/facilitator` and
   the current CDP x402 facilitator API reference at implementation
   time — the Coinbase CDP provider you'll wrap.

## Monorepo structure

```
suverse-pay/
├── apps/
│   └── api/                          REST API server (Fastify)
│       ├── src/
│       │   ├── server.ts             entrypoint
│       │   ├── routes/               route handlers
│       │   ├── plugins/              auth, rate-limit, idempotency
│       │   └── config.ts             env-based config
│       └── package.json
├── services/
│   └── orchestrator/                 routing + provider registry
│       ├── src/
│       │   ├── registry.ts           provider registry
│       │   ├── router.ts             routing engine
│       │   ├── policy.ts             merchant policy resolver
│       │   ├── quote.ts              quote aggregator
│       │   ├── fallback.ts           fallback manager
│       │   ├── capability-discovery.ts   slow cron, refreshes discovered caps
│       │   └── ledger.ts             payment ledger
│       └── package.json
├── packages/
│   ├── core-types/                   shared types + zod schemas
│   │   ├── src/
│   │   │   ├── adapter.ts            ProviderAdapter interface
│   │   │   ├── payment.ts            Payment, Quote, Settle types
│   │   │   ├── chain.ts              CAIP-2 helpers
│   │   │   └── errors.ts             normalized error codes
│   │   └── package.json
│   ├── provider-sdk/                 base class + utilities for adapters
│   │   └── package.json
│   └── adapters/
│       ├── coinbase-cdp/             Coinbase CDP adapter
│       └── cosmos-pay/               our Cosmos facilitator adapter
├── db/
│   ├── migrations/                   SQL migrations (table creation only)
│   ├── bootstrap/                    bootstrap scripts (seed admin key etc)
│   └── schema.sql                    consolidated schema for reference
├── scripts/
│   ├── smoke/mocked/                 smoke tests against mocked adapters
│   └── smoke/real/                   manual smoke tests against real providers
├── docker-compose.yml                postgres + redis for local dev
├── .env.example
├── package.json                      root, pnpm workspace
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
└── README.md
```

> **Phase 2 deliverable, do not scaffold yet:** `apps/mcp/` — the MCP
> server. It will live in this monorepo eventually but MUST NOT be
> created in Phase 1.

## REST API specification

All endpoints require `Authorization: Bearer <api_key>` header.
v0.1 uses a single bootstrapped admin api_key row (see DB section).
Multi-tenancy comes in Phase 4 — the schema is already ready.

### `GET /providers`

List all configured providers and their current health + capabilities.

Response:

```json
{
  "providers": [
    {
      "id": "coinbase-cdp",
      "displayName": "Coinbase CDP",
      "capabilities": [
        {"network": "eip155:8453", "asset": "USDC", "scheme": "exact", "isStatic": true, "isDiscovered": false},
        {"network": "eip155:137", "asset": "USDC", "scheme": "exact", "isStatic": true, "isDiscovered": false},
        {"network": "solana:mainnet", "asset": "USDC", "scheme": "exact", "isStatic": true, "isDiscovered": false}
      ],
      "health": {
        "status": "healthy",
        "successRate7d": 0.987,
        "avgLatencyMs": 230,
        "lastCheckAt": "2026-05-26T01:30:00Z"
      }
    },
    {
      "id": "cosmos-pay",
      "displayName": "Suverse Cosmos Facilitator",
      "capabilities": [
        {"network": "cosmos:grand-1", "asset": "uusdc", "scheme": "exact_cosmos_authz", "isStatic": true, "isDiscovered": true, "discoveredAt": "2026-05-26T00:00:00Z"}
      ],
      "health": { "status": "healthy", "successRate7d": 1.0, "avgLatencyMs": 410, "lastCheckAt": "..." }
    }
  ]
}
```

### `POST /quote`

Get pricing options for a payment across providers, without committing.

Request:

```json
{
  "asset": "USDC",
  "amount": "10000",
  "preferredNetworks": ["eip155:8453", "cosmos:noble-1"],
  "scheme": "exact",
  "policy": {
    "optimize": "cost"
  }
}
```

`policy.optimize`: one of `cost` | `latency` | `success_rate`. Default `cost`.

Response:

```json
{
  "quotes": [
    {
      "providerId": "coinbase-cdp",
      "network": "eip155:8453",
      "asset": "USDC",
      "amount": "10000",
      "estimatedFeeUsd": "0.001",
      "estimatedLatencyMs": 200,
      "scheme": "exact",
      "source": "synthetic"
    },
    {
      "providerId": "cosmos-pay",
      "network": "cosmos:noble-1",
      "asset": "uusdc",
      "amount": "10000",
      "estimatedFeeUsd": "0.0001",
      "estimatedLatencyMs": 400,
      "scheme": "exact_cosmos_authz",
      "source": "synthetic"
    }
  ],
  "recommended": {
    "providerId": "cosmos-pay",
    "reason": "lowest_cost"
  }
}
```

Both providers in v0.1 produce synthetic quotes (neither has a native
quote endpoint). That's expected. The `source` field is typed as
`'native' | 'synthetic'` so future providers with real quote APIs
slot in cleanly.

### `POST /verify`

Verify a payment payload via the optimal provider, without settling.
Used by resource servers to confirm a buyer's payment before doing
expensive work.

Request:

```json
{
  "paymentPayload": { ...x402 PaymentPayload... },
  "paymentRequirements": { ...x402 PaymentRequirements... },
  "providerHint": "cosmos-pay"
}
```

Response:

```json
{
  "valid": true,
  "providerId": "cosmos-pay",
  "payer": "noble1...",
  "verifiedAt": "2026-05-26T01:30:00Z"
}
```

### `POST /settle`

Settle a payment on-chain through the chosen provider, with idempotency
and fallback.

**REQUIRES `Idempotency-Key` header.** Duplicate calls with the same
key MUST return the original response.

Request: same shape as `/verify`. Optional `policy` overrides default
fallback behavior:

```json
{
  "paymentPayload": { ... },
  "paymentRequirements": { ... },
  "policy": {
    "fallback": true,
    "maxAttempts": 3,
    "maxLatencyMs": 5000
  }
}
```

Response (success):

```json
{
  "paymentId": "pay_01HWXYZ...",
  "status": "settled",
  "providerId": "cosmos-pay",
  "providerPaymentId": "...",
  "txHash": "...",
  "network": "cosmos:noble-1",
  "amount": "10000",
  "asset": "uusdc",
  "settledAt": "2026-05-26T01:30:02Z",
  "attempts": [
    {
      "providerId": "coinbase-cdp",
      "outcome": "failed",
      "errorCode": "provider_internal_error",
      "latencyMs": 180
    },
    {
      "providerId": "cosmos-pay",
      "outcome": "success",
      "latencyMs": 1340
    }
  ]
}
```

### `GET /payments/:id`

Look up a payment by ID. Same shape as `/settle` response.

### `GET /health`

Liveness check. Returns 200 if API process is up. Does NOT verify
providers — use `/providers` for that.

### `GET /metrics/summary`

Internal metrics endpoint (gated by admin key).

## Database schema (Postgres)

Use ULIDs (generate in app code via `ulidx` or similar). Times in
`timestamptz` UTC.

```sql
CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY,
  key_hash    TEXT NOT NULL UNIQUE,
  label       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at  TIMESTAMPTZ
);

CREATE TABLE merchant_policies (
  api_key_id  TEXT NOT NULL REFERENCES api_keys(id),
  policy      JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (api_key_id)
);

CREATE TABLE providers (
  id              TEXT PRIMARY KEY,           -- "coinbase-cdp"
  display_name    TEXT NOT NULL,
  config          JSONB NOT NULL,             -- adapter-specific config
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (provider, network, asset, scheme) tuple. Flags indicate
-- whether the capability is declared in static config, runtime-
-- discovered, or both. superseded_at is set when a discovery reveals
-- the capability no longer exists.
CREATE TABLE provider_capabilities (
  provider_id     TEXT NOT NULL REFERENCES providers(id),
  network         TEXT NOT NULL,              -- CAIP-2
  asset           TEXT NOT NULL,
  scheme          TEXT NOT NULL,
  is_static       BOOLEAN NOT NULL DEFAULT FALSE,
  is_discovered   BOOLEAN NOT NULL DEFAULT FALSE,
  discovered_at   TIMESTAMPTZ,
  superseded_at   TIMESTAMPTZ,
  PRIMARY KEY (provider_id, network, asset, scheme),
  CHECK (is_static OR is_discovered)          -- must be at least one
);

CREATE TABLE provider_health_checks (
  id              BIGSERIAL PRIMARY KEY,
  provider_id     TEXT NOT NULL REFERENCES providers(id),
  status          TEXT NOT NULL,              -- "healthy" | "degraded" | "down"
  latency_ms      INTEGER,
  error           TEXT,
  checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON provider_health_checks (provider_id, checked_at DESC);

CREATE TABLE payments (
  id                  TEXT PRIMARY KEY,         -- "pay_01H..."
  idempotency_key     TEXT,                     -- client-supplied
  api_key_id          TEXT NOT NULL REFERENCES api_keys(id),
  status              TEXT NOT NULL,            -- "pending" | "settled" | "failed"
  network             TEXT NOT NULL,
  asset               TEXT NOT NULL,
  amount              NUMERIC(78,0) NOT NULL,   -- atomic units
  payer               TEXT,                     -- bech32/0x address
  recipient           TEXT NOT NULL,
  resource            TEXT,                     -- the URL being paid for
  request_body        JSONB NOT NULL,           -- redacted original request
  final_provider_id   TEXT REFERENCES providers(id),
  final_tx_hash       TEXT,
  error_code          TEXT,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at          TIMESTAMPTZ
);
CREATE UNIQUE INDEX payments_idempotency_idx
  ON payments (api_key_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX ON payments (status, created_at DESC);
CREATE INDEX ON payments (final_provider_id, settled_at DESC);

CREATE TABLE payment_attempts (
  id              BIGSERIAL PRIMARY KEY,
  payment_id      TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  attempt_number  INTEGER NOT NULL,
  provider_id     TEXT NOT NULL REFERENCES providers(id),
  outcome         TEXT NOT NULL,                -- "success" | "failed" | "timeout"
  error_code      TEXT,
  error_message   TEXT,
  latency_ms      INTEGER,
  provider_response JSONB,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX ON payment_attempts (payment_id, attempt_number);
CREATE INDEX ON payment_attempts (provider_id, started_at DESC);

CREATE TABLE routing_decisions (
  id              BIGSERIAL PRIMARY KEY,
  payment_id      TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  candidate_providers JSONB NOT NULL,
  selected_provider_id TEXT NOT NULL,
  policy          JSONB NOT NULL,
  scores          JSONB NOT NULL,
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Bootstrap admin api_key — separate command, not migration

Migrations create empty tables. The admin api_key is seeded by a
**separate bootstrap command**, not a SQL migration. SQL migrations
cannot safely read env vars and hash secrets.

Add a `pnpm db:bootstrap` script that:

1. Reads `ADMIN_API_KEY` from env.
2. Computes its hash (sha256 or argon2).
3. `INSERT INTO api_keys (id, key_hash, label) VALUES
   ('apikey_admin_default', $hash, 'default-admin') ON CONFLICT DO NOTHING`.
4. Exits 0 on success.

Document in README that bootstrap must run once after first
`pnpm db:migrate` and again whenever `ADMIN_API_KEY` is rotated.

The schema then works identically in v0.1 (one row in `api_keys`,
bootstrapped) and Phase 4 (many rows). No transitional state.

## Routing logic v0.1

Pure rule-based, no ML. Implemented in `services/orchestrator/router.ts`.

Algorithm:

1. Gather all providers that support the requested
   `(network, asset, scheme)` tuple via `supports()`. This is the
   **route filter**. Providers that don't support the route are
   excluded here.
2. Filter out providers currently marked unhealthy. Health rule:
   - Compute `failures` and `attempts` for the provider in the last
     60 seconds from `payment_attempts`.
   - Mark unhealthy if AND ONLY IF `attempts >= 10` AND
     `failures / attempts >= 0.3`.
   - If `attempts < 10` (low traffic / quiet period), DO NOT use this
     rule. Instead, look at the latest row in `provider_health_checks`
     — if the most recent active check within the last 5 minutes
     shows status `"down"` or `"degraded"`, filter the provider out.
     Otherwise, keep it.
   - This avoids flapping during low-traffic windows.
3. Score remaining providers:
   - if `policy.optimize === "cost"`: lower fee wins.
   - if `policy.optimize === "latency"`: lower avg latency wins.
   - if `policy.optimize === "success_rate"`: higher success rate wins.
4. Return ordered candidate list.

If `policy.providerHint` is set and the hinted provider passes filters,
it goes first regardless of score.

### Fallback in `/settle`

**Pre-condition for any fallback**: the next candidate provider MUST
satisfy `supports(network, asset, scheme) === true` for the exact same
normalized payment requirements. Providers that don't support the
route are NEVER tried as fallback, even if they're healthy and
configured. There is no "try a random other provider" fallback —
fallback is between providers serving the same route.

If first provider returns a retryable error, try next candidate. If
`policy.maxAttempts` reached, return final failure. If error is
non-retryable, fail immediately.

**Retryable error codes** (try next provider, IF another candidate
supports the same route):

- `network_error` — transient network issue talking to provider
- `timeout` — provider didn't respond in time
- `provider_internal_error` — provider 5xx
- `temporary_unavailable` — provider explicitly says try later
- `rate_limited` — provider quota / 429

**NOT retryable across providers** (return immediately):

- `route_unsupported` — selected provider doesn't actually support
  the requested route. Potential routing bug or stale capability
  cache; log loudly with provider+route context.
- `invalid_signature`, `invalid_authorization`, `nonce_already_used`,
  `expired_authorization`, `insufficient_funds`, `insufficient_grant`
  — all user-side; no other provider would succeed either.

## Provider adapters

### Adapter base contract

In `packages/core-types/src/adapter.ts`:

```typescript
import { z } from "zod";

export const SupportQuerySchema = z.object({
  network: z.string(),     // CAIP-2
  asset: z.string(),
  scheme: z.string(),
});

export const QuoteResponseSchema = z.object({
  providerId: z.string(),
  network: z.string(),
  asset: z.string(),
  amount: z.string(),
  estimatedFeeUsd: z.string(),
  estimatedLatencyMs: z.number(),
  scheme: z.string(),
  source: z.enum(['native', 'synthetic']),
});

// ...similar Verify, Settle, Status schemas...

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  supports(req: z.infer<typeof SupportQuerySchema>): Promise<{ supported: boolean }>;
  quote(req: QuoteRequest): Promise<z.infer<typeof QuoteResponseSchema>>;
  verify(req: VerifyRequest): Promise<VerifyResponse>;
  settle(req: SettleRequest): Promise<SettleResponse>;
  getStatus(providerPaymentId: string): Promise<StatusResponse>;
  healthCheck(): Promise<HealthStatus>;
  discoverCapabilities?(): Promise<DiscoveredCapability[]>;
}
```

### Adapter 1: `cosmos-pay`

Location: `packages/adapters/cosmos-pay/`

Wraps the HTTP API of `sudzikcoin/cosmos-pay`. Calls its `/verify`,
`/settle`, `/supported` endpoints. No crypto in this adapter — cosmos-pay
does all the signing and broadcasting.

Implement `discoverCapabilities()` against cosmos-pay's `/supported`
endpoint.

Config in `providers.config`:

```json
{
  "baseUrl": "https://cosmos-pay.suverse.dev",
  "supportedNetworks": ["cosmos:noble-1", "cosmos:grand-1"],
  "estimatedFeeUsd": "0.0001"
}
```

For v0.1, deploy cosmos-pay to the same VPS or use a public testnet
URL; document in README how to point at it.

### Adapter 2: `coinbase-cdp`

Location: `packages/adapters/coinbase-cdp/`

Wraps the Coinbase Developer Platform facilitator API. Read current
CDP x402 facilitator docs at implementation time for the exact API
surface and auth scheme — both are subject to change.

Config:

```json
{
  "baseUrl": "https://api.cdp.coinbase.com/platform/v2/x402",
  "credentials": {
    "_comment": "Provider-specific auth scheme. The adapter implements whatever credential format the current CDP x402 facilitator API requires (Bearer token, signed JWT, HMAC, etc.). Env var names are adapter-internal.",
    "envVarPrefix": "COINBASE_CDP_"
  },
  "supportedNetworks": ["eip155:8453", "eip155:137", "eip155:42161", "eip155:480", "solana:mainnet"],
  "monthlyFreeQuota": 1000,
  "estimatedFeeUsd": "0.001"
}
```

The adapter reads `COINBASE_CDP_*` env vars and constructs whatever
auth header CDP currently expects. Do NOT hardcode `API_KEY+SECRET`
assumptions in the gateway code — treat all CDP auth as adapter-internal.

If CDP exposes a way to discover supported networks (e.g. via
`/supported` or `/networks`), implement `discoverCapabilities()`.
Otherwise omit it and rely on static config.

CRITICAL: the adapter MUST track its own monthly usage in Redis
(simple counter, reset on the 1st of each month UTC). If usage exceeds
`COINBASE_CDP_MONTHLY_HARD_CAP` (default 5000), the adapter returns
`quota_exceeded` from `supports()` instead of making the call.

## Environment variables

`.env.example`:

```
NODE_ENV=development
LOG_LEVEL=info

# API
API_PORT=3000
ADMIN_API_KEY=replace-me-with-a-long-random-string

# Database
DATABASE_URL=postgres://suverse:suverse@localhost:5432/suverse_pay

# Redis
REDIS_URL=redis://localhost:6379

# Provider: cosmos-pay
COSMOS_PAY_BASE_URL=http://localhost:8402

# Provider: coinbase-cdp
# These vars are adapter-internal — the adapter reads whatever is
# needed for the current CDP x402 facilitator auth scheme. As of
# mid-2026 CDP uses an API key + secret pair, but verify against
# current CDP docs before relying on these exact names.
COINBASE_CDP_API_KEY=
COINBASE_CDP_API_SECRET=
COINBASE_CDP_MONTHLY_HARD_CAP=5000

# OpenTelemetry (optional)
OTEL_EXPORTER_OTLP_ENDPOINT=
```

## Acceptance criteria

Two gates: Phase 1 done (CI-enforceable, mocked) vs v0.1.0 release
(manual, real providers).

### Required for Phase 1 done

1. **Build clean.** `pnpm install && pnpm build` exits 0.
2. **Tests green.** `pnpm test` exits 0. Each adapter has unit tests
   with mocked HTTP. Orchestrator has unit tests for routing logic.
   At least one integration test runs the full API end-to-end against
   mocked adapters (HTTP-level mocks via nock or msw).
3. **Local stack runs.** `docker-compose up -d` brings up Postgres and
   Redis. `pnpm db:migrate` applies migrations. `pnpm db:bootstrap`
   seeds the admin api_key from `ADMIN_API_KEY`. `pnpm dev` starts
   the API on `:3000`.
4. **Mocked smoke tests pass** (scripts in `scripts/smoke/mocked/`):
   - `GET /health` → 200
   - `GET /providers` → both providers listed with static
     capabilities populated, discovered ones if reachable
   - `POST /quote` returns synthetic quotes from both adapters
   - `POST /quote` with `optimize=cost` returns ordered list
   - `POST /settle` against mocked cosmos-pay adapter → returns
     settle response with mock tx hash
   - Same `POST /settle` with same Idempotency-Key → returns same
     response, mocked adapter NOT called twice (verify via mock
     assertions)
   - `POST /settle` simulating first-provider failure → falls back
     to second; both attempts recorded in DB
   - `POST /settle` with unsupported route → fails immediately
     without trying any provider, `errorCode: "route_unsupported"`
   - `GET /payments/:id` → returns payment with all attempts
   - `GET /metrics/summary` → returns aggregate stats
5. **README** has copy-paste runnable quick start (mocked mode).
6. **CHANGELOG.md** has an entry for the version (exact naming
   flexible — `v0.1.0-rc.1` or `unreleased` both fine).

### Required for v0.1.0 release tag (manual, real providers)

These run against real external services and are NOT in CI. They must
pass at least once before tagging `v0.1.0`. Do not block Phase 1
"done" on these — they're a release gate.

7. **Real cosmos-pay end-to-end on Cosmos testnet.** Deploy or run
   cosmos-pay locally, point the gateway at it, run a real `/settle`
   against `cosmos:grand-1` (or whichever Cosmos testnet cosmos-pay
   supports at release time). Verify the returned tx hash is
   queryable on the appropriate explorer.

8. **Real Coinbase CDP smoke (if API key available).** Run one
   `/settle` against a currently supported CDP x402 test environment
   — verify the exact network/testnet from current CDP docs at
   release time. Confirm the adapter handles the actual CDP auth
   scheme and response shape. If no CDP API key yet, document the
   gap and mark this as deferred.

At end of Phase 1, distinguish clearly which acceptance criteria
passed vs deferred. "All mocked criteria green, real-network deferred
pending cosmos-pay deployment" is an acceptable Phase 1 completion.
Tagging `v0.1.0` without #7 passing is not.

## Implementation order

Stick to this sequence. Each step ends with a green build.

1. Repo scaffolding: pnpm workspace, turbo, tsconfig, Docker compose,
   CI skeleton.
2. `packages/core-types` — all shared types and Zod schemas.
3. `packages/provider-sdk` — base adapter class with retry, timeout,
   health-check helpers.
4. `packages/adapters/cosmos-pay` — adapter for our Cosmos facilitator.
5. `packages/adapters/coinbase-cdp` — adapter for Coinbase CDP. Stub
   with mock first, real HTTP calls once Coinbase API key provided.
6. `services/orchestrator` — registry, routing, fallback, ledger,
   capability discovery cron.
7. `apps/api` — Fastify server, routes, plugins, idempotency.
8. DB migrations (table creation only).
9. `db/bootstrap` script for seeding admin api_key.
10. Integration tests with mocked adapters.
11. Smoke test scripts (mocked).
12. README + CHANGELOG.

## What to ask the user about before proceeding

- **Coinbase CDP API key + secret.** Required to test the Coinbase
  adapter against real endpoints. Until provided, use a mock and
  proceed. Tell the user when you reach step 5 integration tests.

- **cosmos-pay deployment URL.** If they haven't deployed publicly,
  the adapter points at `http://localhost:8402` for local dev. For
  real `v0.1.0` release testing they need to either run cosmos-pay
  locally on the same machine or deploy it.

- **Domain name.** Eventually `api.suverse.dev` or similar. Not
  blocking for v0.1.

Do NOT ask permission to: install dependencies, run migrations, run
tests, refactor within the prescribed structure, commit, push.
Proceed with all of that.
