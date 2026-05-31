# `@suverse-pay/proxy`

Self-serve x402 proxy. Wraps any upstream HTTP API behind a paid
`/v1/proxy/{resourceKeyId}/{slug}` endpoint without seller-side
code: the seller configures the upstream URL + forward headers in
the dashboard, the proxy enforces the 402 challenge / verify /
settle dance against `facilitator.suverse.io`, and on success
forwards the buyer's original method + body to the upstream with
the seller's encrypted auth headers attached.

## Request flow

```
buyer  ─►  POST /v1/proxy/{resourceKeyId}/{slug}
            │
            │  1. lookup seller_proxy_configs (Postgres, 60s in-process cache)
            │  2. is_active? method matches? acceptedPayments built?
            │  3. ── upstream health probe (only if no X-Payment) ──
            │       HEAD the upstream URL with HEALTH_CHECK_TIMEOUT_MS
            │       budget. 4xx is healthy (auth-gated endpoint is up);
            │       5xx / network error / timeout → 503 retry-after: 30.
            │  4. runProtocol (@suverselabs/x402-server)
            │       ├─ no X-Payment        → 402 challenge body
            │       ├─ verify+settle fail  → 402 with reason
            │       └─ accepted            → continue
            │  5. fetch(upstream, method, body, merged headers)
            │  6. stream response back with PAYMENT-RESPONSE header
            │  7. row in proxy_request_logs
            ▼
buyer  ◄─  upstream's response
```

## Why a pre-charge health check

Without it: buyer pays, then the proxy forwards to an upstream
that has been down for an hour. Buyer is out the settlement amount
and gets a 5xx body. Goodwill destroyed.

With it: before we ever hand back a 402 challenge, we issue an
unauthenticated `HEAD` against the seller's configured upstream
URL. If the upstream is dead — DNS failure, connection refused,
TLS handshake error, timeout, or 5xx — the buyer sees a 503
upstream_unavailable response with `retry-after: 30` and never
takes out their wallet.

Buyers who already include an `X-Payment` header skip the probe.
That request is a retry by someone who has already chosen to pay,
and we'd rather they see the real upstream error than have the
probe block their settlement attempt.

### Status policy

| Probe response          | Verdict | Behavior                          |
|-------------------------|---------|-----------------------------------|
| 1xx / 2xx / 3xx         | healthy | continue into 402 challenge       |
| 4xx (401, 403, 404, …)  | healthy | continue — endpoint is gated, server is up |
| 5xx (500–599)           | down    | 503 `upstream_unavailable`        |
| 405 / 501               | retry   | fall back to GET against the same budget |
| network error / DNS     | down    | 503 `network_error`               |
| abort / timeout         | down    | 503 `timeout`                     |

`HEAD` returning 4xx without auth headers is exactly what a live,
gated upstream should do — promoting that to "down" would lock
buyers out of every API that authenticates at the door.

## Environment

| Variable                      | Required | Default          | What it does                          |
|-------------------------------|----------|------------------|---------------------------------------|
| `DATABASE_URL`                | yes      | —                | Postgres connection string            |
| `PROXY_HEADER_KEY`            | yes      | —                | base64-encoded 32-byte AES master key |
| `FACILITATOR_URL`             | yes      | —                | e.g. `https://facilitator.suverse.io` |
| `PROXY_RESOURCE_API_KEY`      | yes      | —                | resource key the proxy speaks with    |
| `PORT`                        | no       | `3003`           |                                       |
| `HOST`                        | no       | `0.0.0.0`        |                                       |
| `REDIS_URL`                   | no       | (in-memory)      | shared rate-limit state               |
| `RATE_LIMIT_PER_MIN`          | no       | `120`            | per-(slug,IP) cap                     |
| `LOG_LEVEL`                   | no       | `info`           | pino log level                        |
| `HEALTH_CHECK_TIMEOUT_MS`     | no       | `3000`           | pre-charge probe budget               |

## Local development

```bash
pnpm --filter @suverse-pay/proxy dev          # tsx watch
pnpm --filter @suverse-pay/proxy test         # vitest unit suite
pnpm --filter @suverse-pay/proxy typecheck    # tsc --noEmit
pnpm --filter @suverse-pay/proxy build        # tsc emit
```

The full per-request handler lives in
[`src/handler.ts`](src/handler.ts) and is exercised directly by
[`tests/handler.test.ts`](tests/handler.test.ts) without booting
Fastify. The upstream health probe is a standalone unit in
[`src/upstream-health.ts`](src/upstream-health.ts) with its own
test suite in
[`tests/upstream-health.test.ts`](tests/upstream-health.test.ts).
