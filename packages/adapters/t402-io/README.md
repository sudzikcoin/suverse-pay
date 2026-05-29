# @suverse-pay/adapter-t402-io

Adapter wrapping [t402-io](https://github.com/t402-io/t402)'s
"universal USDT protocol" facilitator. Phase 4 Block 2 Sub-task 10.
**The final adapter of Block 2 — Block 3 closes Phase 4 from here.**

## Strategic value

t402-io is essentially a clean fork of x402 with one renaming on the
wire (`t402Version` instead of `x402Version`). Their hosted
facilitator at `https://facilitator.t402.io` advertises **77 (network,
scheme) tuples** spanning **11 namespaces**:

| Namespace | Networks live | Schemes |
| --- | --- | --- |
| `eip155:` (EVM) | 22 chains incl. Ethereum, Optimism, Polygon, Base, Arbitrum, Sei, Monad, World Chain | `exact`, `exact-legacy`, `upto` |
| `tron:` | mainnet, nile, shasta | `exact` |
| `solana:` | mainnet + devnet | `exact` |
| `cosmos:` | grand-1, **noble-1 (MAINNET)** | `exact-direct` |
| `aptos:` | 1, 2 | `exact-direct` |
| `near:` | mainnet, testnet | `exact-direct` |
| `polkadot:` | two CAIP-2 hashes | `exact-direct` |
| `stacks:` | 1, 2147483648 | `exact-direct` |
| `stellar:` | pubnet, testnet | `exact` |
| `tezos:` | two CAIP-2 hashes | `exact-direct` |
| `ton:` | mainnet, testnet | `exact` |

**Headline**: this is the first time the gateway reaches
`cosmos:noble-1` **mainnet** (Block 1 Sub-task 5 had deferred the
funded-facilitator approach; t402-io provides an off-the-shelf route).

## Maturity disclosure

The adapter is built honestly against a young, small project. Operators
should weigh these flags:

- **`/health` reports `version: "dev"`** — not production-versioned.
- **GitHub footprint**: org created 2025-12-15; 3 stars; 1 main
  contributor (`awesome-doge` with 1993 commits) plus dependabot.
- **API key gating**: `/verify` and `/settle` require `X-API-Key`
  header. **No public signup flow discovered** in their repo as of
  2026-05-29 — the adapter registers in capability-only mode without
  a key.
- **Mechanism churn**: recent CHANGELOG entries show active
  reshuffling (the "Spark mechanism" was deleted across 4 SDKs the
  same day a Dispute extension was added).

That said, the infrastructure is **real and live** — `/supported`,
`/health`, and the gated `/verify` + `/settle` all respond. Schemas
match our wire expectations.

## Wire shape

t402's body is `{paymentPayload, paymentRequirements}` plus
`t402Version` instead of x402's `x402Version`. Otherwise identical.
The adapter emits **both** version fields for safety (see
`adapter.ts::toT402Request`) — t402-io's facilitator code reads
whichever is present.

```
POST /verify
{
  "t402Version": 2,
  "x402Version": 2,
  "paymentPayload": {...},
  "paymentRequirements": {...}
}
```

Response shape mirrors x402: `{isValid, invalidReason, ...}` for
verify, `{success, transaction, errorReason, ...}` for settle. The
adapter normalizes everything through `mapT402ErrorReason` to
`@suverse-pay/core-types`'s `ErrorCode` vocabulary.

## Capability scope today

The gateway registers a deliberately scoped subset of what t402-io
advertises — namespaces × schemes we have a working signer for:

- **EVM `exact`**: Ethereum (1), Optimism (10), Polygon (137), Base
  (8453), Arbitrum (42161) — USDT contracts. Signer-evm produces
  compatible signatures.
- **Cosmos `exact-direct` mainnet**: `cosmos:noble-1` with native
  USDT (`uusdt`). cosmos-pay handles signing; this is the gateway's
  first Cosmos mainnet route.
- **Solana `exact` mainnet**: USDT SPL mint. signer-solana exists.

NOT registered (advertised by t402-io, signer-blocked in this gateway
until Phase 5):
- TON, NEAR, Aptos, Tezos, Polkadot, Stacks, Stellar — no native
  signers in suverse-pay yet.
- BSC (`eip155:56`), Avalanche (`eip155:43114`) — t402-io advertises
  these only under `exact-legacy`, which we don't currently route.
  Both networks are already covered by Binance/PayAI/BofAI for
  `exact`.

## Configuration

```ts
import { T402IoAdapter } from "@suverse-pay/adapter-t402-io";

const adapter = new T402IoAdapter({
  apiKey: process.env.T402_IO_API_KEY, // X-API-Key header
  capabilities: [
    { network: "cosmos:noble-1", asset: "uusdt", scheme: "exact-direct" },
    // ... more
  ],
  estimatedFeeUsd: "0.001",
  // baseUrl: "https://facilitator.t402.io",  // default
});
```

Env vars consumed by `apps/api`:

- `T402_IO_API_KEY` — sent as `X-API-Key` header on verify/settle.
- `T402_IO_BASE_URL` — defaults to `https://facilitator.t402.io`.
- `T402_IO_ENABLED` — defaults to `true`; set `false` to skip.

## Sources

- [t402-io/t402 repo](https://github.com/t402-io/t402) — monorepo
- [t402 whitepaper](https://t402.io/t402-whitepaper.pdf)
- Live `/supported` probe 2026-05-29, cached at
  `test-fixtures/t402-supported.json` (77 entries, 11 namespaces).
- `specs/usdt-tokens.md` in the t402-io monorepo — token addresses
  per chain.
