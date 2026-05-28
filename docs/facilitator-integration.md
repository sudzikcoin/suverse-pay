# Integrating suverse-pay as your x402 facilitator

A resource server (the seller side of an x402 transaction) can point
its x402 middleware at `https://YOUR_DEPLOYMENT/facilitator` and get
multi-chain payment routing through a single facilitator URL.
Under the hood we route across cosmos-pay, Coinbase CDP, and PayAI
based on the requested `(network, scheme)` — your code doesn't see
the underlying facilitator change.

This guide covers what's exposed at `/facilitator/*`, how to obtain a
resource API key, and how to wire common x402 middleware libraries.

## Endpoints

All endpoints live under the `/facilitator` prefix. Authentication
varies — read-only and verify routes are OPEN, settlement requires a
resource API key.

| Method | Path                        | Auth                     | Purpose                                                              |
|--------|-----------------------------|--------------------------|----------------------------------------------------------------------|
| GET    | `/facilitator/health`       | none                     | Liveness probe — returns `{status: "ok", x402Version: 2}`            |
| GET    | `/facilitator/supported`    | none                     | x402 spec §7.3 SupportedResponse — list of supported (scheme, network) |
| POST   | `/facilitator/verify`       | none                     | x402 spec §7.1 — validate a payment payload without settling          |
| POST   | `/facilitator/settle`       | `Bearer <resource-key>`  | x402 spec §7.2 — settle a payment on-chain (rate-limited per key)     |

All requests and responses follow the canonical x402 v2 wire format
([spec](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)).

## Supported networks

Authoritative source: `GET /facilitator/supported` against your
deployment. The static routing config in `services/facilitator/src/routing-config.ts`
documents the same set:

| Network                                            | Scheme                  | Backing facilitator                              |
|----------------------------------------------------|-------------------------|--------------------------------------------------|
| `cosmos:grand-1` (Noble testnet)                   | `exact_cosmos_authz`    | cosmos-pay                                       |
| `eip155:8453` (Base mainnet)                       | `exact`                 | Coinbase CDP                                     |
| `eip155:137` (Polygon mainnet)                     | `exact`                 | Coinbase CDP                                     |
| `eip155:42161` (Arbitrum mainnet)                  | `exact`                 | Coinbase CDP                                     |
| `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (Solana mainnet) | `exact`         | Coinbase CDP (primary) → PayAI (failover)        |
| `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (Solana devnet) | `exact`           | PayAI                                            |

The CAIP-2 network identifiers are the canonical genesis-hash form
per the x402 spec — `solana:mainnet` is NOT accepted.

## Failover guarantees

When a route has multiple backing facilitators (currently: Solana
mainnet → CDP then PayAI), the gateway will:

1. Try the primary first.
2. On a **retryable** error (network timeout, 5xx, rate limit,
   blockhash expired, etc.) → try the secondary with the SAME
   `Idempotency-Key`.
3. On a **terminal** error from the primary
   (`invalid_signature`, `expired_authorization`, `insufficient_funds`,
   etc.) → return that error to you. No failover, no second on-chain tx.
4. Record every failover attempt in `facilitator_failover_events`
   (available via `/metrics/summary`).

The same idempotency key passing to both adapters is what prevents
double-broadcast — any facilitator that respects it on its side
won't mint a second tx. Routes with a single backing facilitator
(Cosmos, EVM) trivially have no failover concern.

## Idempotency

Every `/facilitator/settle` request is deduplicated server-side by
the tuple `(resource_key_id, payer_address, payload_nonce, hour_bucket)`.

- **Same call, replayed within the hour** → returns the original
  response without re-broadcasting. This is the strong invariant.
- **Same call from a DIFFERENT tenant** (different resource key) →
  treated as independent — each tenant has its own idempotency
  namespace. One tenant cannot shadow another's payments.
- **Same call across the hour boundary** → fresh record. Honest
  retries an hour later are not blocked.

You do NOT need to send an `Idempotency-Key` header — we derive
ours deterministically. The header is reserved for future use.

## Quick start

### 1. Obtain a resource API key

For v0.3.0 keys are issued manually. Contact the operators with:

- A label (e.g. `weather-api.example.com`).
- An expected request rate.
- An expected monthly settle volume (for tier sizing).

Operators run:

```bash
pnpm --filter @suverse-pay/db run bootstrap-resource-key -- \
  --label "weather-api.example.com" \
  --rate-limit 120 \
  --monthly-cap 100000
```

The CLI prints the plaintext key ONCE. The operator hands it to you
out-of-band. Subsequent retrieval requires re-issuing a new key.

### 2. Configure your x402 middleware

Point your middleware's `facilitator` URL at our deployment and
include the resource key as a bearer token.

**Node.js (`x402-express` / similar):**

```ts
import { x402Middleware } from "@coinbase/x402-express";

app.use(
  "/api/data",
  x402Middleware({
    facilitator: "https://YOUR_DEPLOYMENT/facilitator",
    apiKey: process.env.SUVERSE_PAY_RESOURCE_KEY,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: process.env.YOUR_BASE_ADDRESS,
        amount: "10000", // 0.01 USDC
        maxTimeoutSeconds: 60,
        extra: { name: "USD Coin", version: "2" },
      },
      {
        scheme: "exact_cosmos_authz",
        network: "cosmos:grand-1",
        asset: "uusdc",
        payTo: process.env.YOUR_NOBLE_ADDRESS,
        amount: "10000",
        maxTimeoutSeconds: 60,
        extra: { facilitator: "noble1grantee...", chainId: "grand-1" },
      },
    ],
  }),
);
```

The exact accepted-payments format is middleware-specific; the field
shapes above match the x402 v2 `PaymentRequirements` schema.

### 3. Test against your deployment

```bash
curl -sS https://YOUR_DEPLOYMENT/facilitator/supported | jq
# → { "kinds": [...], "extensions": [], "signers": {} }

curl -sS https://YOUR_DEPLOYMENT/facilitator/health
# → { "status": "ok", "x402Version": 2 }
```

## Rate limits

The default plan is **60 requests per minute** of `/facilitator/settle`
per resource key, with **no monthly settle cap** unless one was set
on key issuance. Limits are tracked in a sliding window — bursts up
to the limit are allowed, sustained excess is throttled.

When the limit is exceeded the gateway returns HTTP 429 with an
error body of `{error: {code: "rate_limited", message: "..."}}`.
The message includes a `retry after Ns` hint; clients should
respect it.

`GET /facilitator/supported`, `POST /facilitator/verify`, and
`GET /facilitator/health` are NOT rate-limited — they're stateless
and cheap.

To raise your limit, contact the operators.

## Error responses

`/facilitator/verify` and `/facilitator/settle` map errors to the
canonical x402 error vocabulary (see
`packages/core-types/src/errors.ts`). The most common codes:

| Code                          | When you'll see it                                                              |
|-------------------------------|---------------------------------------------------------------------------------|
| `unauthorized`                | Missing or invalid resource API key (settle only)                               |
| `rate_limited`                | Exceeded per-key sliding-window limit                                           |
| `route_unsupported`           | `(network, scheme)` has no backing facilitator                                  |
| `invalid_request`             | Request body failed schema validation                                           |
| `invalid_signature`           | Underlying facilitator rejected the payment signature                           |
| `invalid_authorization`       | Underlying facilitator rejected the authorization params (window, chain, etc.) |
| `expired_authorization`       | `validBefore` already passed at facilitator time                                |
| `insufficient_funds`          | Payer's wallet doesn't have the asset balance to cover the payment              |
| `insufficient_grant`          | Payer's x/authz / allowance has been exhausted                                  |
| `broadcast_failed`            | Facilitator submitted but the on-chain broadcast failed                         |
| `provider_internal_error`     | Facilitator returned an unknown errorReason (logged for operator follow-up)     |

`/verify` always returns HTTP 200 with `{isValid: false, invalidReason}`
on validation failures — the HTTP layer reserves 4xx/5xx for
transport-level problems (auth, schema, no route).

## Observability

Operators can query `GET /metrics/summary` (admin auth) to see:

- `facilitator.paymentsByResourceKey` — settle counts per key (24h)
- `facilitator.paymentsByNetwork` — what networks are seeing traffic
- `facilitator.adapterSelections` — which under-the-hood adapter was chosen
- `facilitator.failoverEvents` — how often the primary failed and backup was tried

Tenants who want their own usage stats: contact operators for a
per-key dashboard slice. Programmatic access via `/metrics` from
resource servers is not exposed in v0.3.0.

## Known limitations (v0.3.0)

- **Manual key issuance.** No self-serve signup. Phase 4 will add a
  small admin UI + key rotation primitives.
- **Single resource-key plan.** Rate limit and monthly cap are set at
  issuance time and updated by the operator. No tiered plans yet.
- **No HMAC request signing.** Bearer keys over TLS only. An HMAC
  scheme over the request body is a Phase 4 candidate.
- **`/facilitator/quote` not exposed.** The internal `/quote` route
  takes an admin key and is for the MCP server's own routing. Phase
  4 will expose a public quote endpoint.
- **Webhooks not implemented.** Settlement notifications are
  request-response only — your middleware learns about the settle
  status from the `/facilitator/settle` response body.

## Smoke testing

Two suites exercise the public facilitator surface end-to-end:

- `scripts/smoke/facilitator-mocked/run-all.sh` — 10 steps against a
  mocked gateway. Covers `/supported`, `/health`, `/verify` for
  Cosmos and EVM payloads, `/settle` with admin and resource-key
  auth, missing-auth and bad-auth rejection, rate limit, and
  idempotency. No real network. Useful for verifying a change to the
  routing surface before deployment.
- `scripts/smoke/real/run-all.sh` — 9 steps against a real
  cosmos-pay facilitator on Noble grand-1. Covers the
  admin-authenticated `/settle` path that resource-key auth
  delegates to. Produces a real `MsgSend` tx hash queryable on
  [Mintscan](https://www.mintscan.io/noble-testnet) — set the
  `EXPLORER` link returned in the step output.

Run them in that order after touching anything in
`services/facilitator/` or `services/orchestrator/`.
