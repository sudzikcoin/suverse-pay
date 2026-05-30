# Changelog

## 0.3.0 — 2026-05-30

**Facilitator-extras auto-discovery** — the middleware now fetches
your facilitator's `GET /facilitator/supported` at boot, caches the
per-kind `extra` field it advertises (Solana `feePayer`, Cosmos
grantee + chainId, EVM EIP-712 USDC domain), and merges those values
into every 402 challenge automatically.

Sellers no longer need to know infrastructure-specific details:

```ts
// Pre-v0.3.0 — manual hardcoding required
acceptedPayments: [
  {
    scheme: "exact",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    payTo: "MyMerchantAddress",
    maxAmountRequired: "70000",
    extra: { feePayer: "<which feePayer? whose? from where?>" }, // ❌ painful
  },
]

// v0.3.0 — facilitator publishes feePayer; middleware merges it in
acceptedPayments: [
  {
    scheme: "exact",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    payTo: "MyMerchantAddress",
    maxAmountRequired: "70000",
    // no `extra` needed ✓
  },
]
```

### Behavior

- Cache is keyed by facilitator URL, in-process, default TTL **1 hour**.
- Boot-time best-effort warm via `validateOptions()` — first 402 doesn't
  pay the fetch latency in steady state.
- On fetch error (timeout, DNS, non-200, malformed body): the middleware
  **does not throw** — it falls back to seller-only extras and logs a
  warning via `opts.logger`. Same behavior as v0.2.0.
- Concurrent fetches against the same facilitator URL are deduplicated.

### Merge precedence

When both the facilitator and the seller publish `extra` for the same
kind, the merge is `{ ...facilitatorExtras, ...sellerExtras }` — **seller
wins per key**. This keeps pre-v0.3.0 configs that hardcode `extra`
working unchanged, and lets sellers override individual values
(e.g. their own `name`/`version` for a token domain) while still
inheriting the rest from the facilitator.

### New options

- `disableAutoDiscover?: boolean` (default `false`) — opt out of the
  whole mechanism; behaves exactly like v0.2.0.
- `facilitatorExtrasCacheTtlMs?: number` (default `3_600_000` =
  1 hour) — cache TTL.

### Breaking changes

- **`buildChallenge` is now `async`.** Internal callers in
  `runProtocol` were updated. If you imported `buildChallenge`
  directly, replace `buildChallenge(...)` with `await buildChallenge(...)`.
  The Express + Fastify adapters are unaffected — they only call
  `runProtocol`, which was already async.

### New public API

```ts
import {
  getFacilitatorExtras,
  getAllFacilitatorExtras,
  warmFacilitatorCache,
} from "@suverselabs/x402-server";
```

Most users don't need these — `buildChallenge` consumes them
transparently — but they're exported for explicit boot wiring,
debugging tools, and tests.

### Compatibility

- Old facilitators (pre-suverse-pay-PR-A) return `/supported` without
  per-kind `extra` — middleware degrades to v0.2.0 behavior cleanly.
- Old sellers (with hardcoded `extra` per accept) keep working: seller
  values win on merge.
- Wire format (the 402 challenge body) is unchanged. v0.2.0 buyers see
  the same shape they saw before — just with additional fields under
  `extra`.

---

## 0.2.0 — 2026-05-30

x402 v2 ecosystem-client interop (PR #2, commit `6743faf`).

- `buildChallenge` emits the Coinbase-flavour v2 shape (top-level
  structured `resource`, per-accept `amount`/`maxTimeoutSeconds`,
  optional `extra` per accept).
- `decodePaymentHeader` accepts both v2 (nested `accepted`) and v1
  (flat top-level) `X-Payment` shapes.
- Express + Fastify adapters read `PAYMENT-SIGNATURE` (v2) with
  `X-PAYMENT` fallback (v1), emit `PAYMENT-REQUIRED` +
  `PAYMENT-RESPONSE` headers with CORS expose.

## 0.1.0 — initial release

Express + Fastify subpath adapters, Apache-2.0.
