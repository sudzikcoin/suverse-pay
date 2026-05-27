# @suverse-pay/adapter-payai

Provider adapter for [PayAI](https://payai.network)'s x402 facilitator at
`https://facilitator.payai.network`. Wraps the standard x402 v2
facilitator HTTP API (`/verify`, `/settle`, `/supported`) and exposes
it through the orchestrator's `FacilitatorAdapter` contract.

PayAI is suverse-pay's **third facilitator** (after cosmos-pay and
Coinbase CDP) and our **second route for Solana** — the gateway can
fail over from CDP to PayAI for Solana payments when CDP is rate-
limited, returns a retryable error, or is otherwise unavailable.

## Supported networks

| CAIP-2 | Asset | Asset identifier | Scheme |
|---|---|---|---|
| `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (Solana mainnet) | USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `exact` |
| `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (Solana mainnet) | EURC | `HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr` | `exact` |

PayAI's live `/supported` (captured 2026-05-28) advertises a much
broader set — Base, Polygon, Arbitrum, Avalanche, IoTeX, Sei, SKALE,
X Layer, Peaq, KiteAI, plus their testnets, plus Solana devnet. The
adapter is constructed with a narrower static set focused on Solana
because:

1. The other networks are already covered by Coinbase CDP (or, for
   Cosmos networks, by cosmos-pay). PayAI's role today is the Solana
   route + failover.
2. Advertising the same `(network, asset, scheme)` from two adapters
   without an explicit failover policy would create unpredictable
   routing. The orchestrator's policy engine handles preference
   ordering, but the adapter's static set is the floor.

Future Solana devnet support can be enabled by adding
`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` to the capability list —
the adapter machinery is identical. The mainnet entries are the
Phase 3 baseline.

## Authentication

PayAI offers a **free tier** (no authentication, up to 10 000
settlements per month per source IP/key) and a **paid tier** with
API key + secret for higher rate limits. The adapter supports both:

| Env var | Required | Purpose |
|---|---|---|
| `PAYAI_ENABLED` | no | Set to `false` to skip PayAI registration. Default `true`. |
| `PAYAI_BASE_URL` | no | Override the default `https://facilitator.payai.network`. |
| `PAYAI_API_KEY_ID` | no (paid tier only) | API key id. Free tier leaves this unset. |
| `PAYAI_API_KEY_SECRET` | no (paid tier only) | API key secret. Free tier leaves this unset. |

When BOTH `PAYAI_API_KEY_ID` and `PAYAI_API_KEY_SECRET` are set, the
adapter sends `Authorization: Basic <base64(id:secret)>` on every
request. Otherwise it sends no `Authorization` header — the free tier
just works.

## Wire shapes per network

The adapter is fully network-agnostic. `verify()` and `settle()`
forward `paymentPayload` + `paymentRequirements` to PayAI verbatim —
PayAI does the network-specific verification server-side. The
inbound payload shapes per signing scheme:

- **Solana (`exact`)**: `payload.transaction` — base64-encoded
  partially-signed versioned Solana transaction (PayAI fills in the
  feePayer signature and submits).

PayAI's `/supported` Solana entries include `extra.feePayer` — that's
PayAI's facilitator pubkey that clients should set as
`PaymentRequirements.extra.feePayer` when signing transactions
destined for PayAI. The adapter exposes this through the standard
discovery flow; downstream callers (`apps/mcp`, integrators) read it
from the cached capability data.

## Idempotency

PayAI does not document `Idempotency-Key` support. The SVM `exact`
spec (`scheme_exact_svm.md` §"Duplicate Settlement Mitigation") does
mandate a short-lived facilitator-side cache to prevent
double-settlement of the same base64 transaction within ~120 seconds,
so re-sending an identical settle request is safe at the protocol
layer.

The adapter still sets `Idempotency-Key` on outbound requests when
the orchestrator supplies one — a future PayAI server that honours
the header gets correct behaviour automatically.

## Real-network smoke

**Deferred to Phase 3 Sub-task 7** — requires a funded Solana mainnet
wallet (real money) OR PayAI devnet smoke if their devnet
facilitator accepts unrelated payers. Today, adapter wiring is
verified via:

- Mocked unit tests for happy and error paths (`adapter.test.ts`).
- One real `/supported` integration test (`integration.test.ts`)
  that caches PayAI's actual response to `test-fixtures/`. The cache
  decouples the build from PayAI's uptime; delete the fixture to
  refresh.
- Offline signing math via `@suverse-pay/signer-solana`'s
  `nacl.sign.detached.verify` round-trip — proves the payloads we'd
  send are mathematically correct.

## Tests

```bash
pnpm --filter @suverse-pay/adapter-payai test
```

31 tests:

- `adapter.test.ts` — 28 mocked tests (basics, auth, verify, settle,
  healthCheck, discoverCapabilities, getStatus, URL parsing).
  Covers HTTP 401 / 5xx error paths, retry+Idempotency-Key propagation
  on 5xx when key supplied, Solana `broadcast_failed` and
  `duplicate_settlement` error mapping, and v1-entry filtering during
  discovery (PayAI advertises both x402 v1 and v2 forms; the adapter
  ignores v1 to avoid duplicate capabilities).
- `integration.test.ts` — 1 real `/supported` test against the live
  PayAI facilitator. Asserts the response parses and includes
  Solana mainnet v2. Cached for rerun stability.

## Maturity / reliability signals

- PayAI is a public x402 facilitator with documentation at
  <https://docs.payai.network>. Free tier with no auth is in place,
  paid tier with key id + secret is documented.
- Open-source presence; the project has a `$PAYAI` token and
  associated tokenomics docs (out of scope for adapter integration).
- Live `/supported` (2026-05-28) advertises 58 `(scheme, network)`
  kinds across 40 unique networks — broad coverage. PayAI has been
  consistently reachable during integration testing.
- No public SLA or incident history documented at the time of writing.
  Treat PayAI as a secondary route that supplements (not replaces)
  Coinbase CDP for Solana; routing policy in the orchestrator
  decides primary vs failover ordering.
