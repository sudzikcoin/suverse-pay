# @suverse-pay/adapter-coinbase-cdp

Provider adapter that wraps Coinbase Developer Platform's hosted x402
facilitator (`https://api.cdp.coinbase.com/platform/v2/x402`). The
adapter is fully network-agnostic: it forwards `paymentPayload` +
`paymentRequirements` to CDP verbatim and normalizes the response into
the orchestrator's contract from `@suverse-pay/core-types`.

## Supported networks

| CAIP-2 | Asset | Asset identifier | Scheme |
|---|---|---|---|
| `eip155:8453` (Base) | USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `exact` |
| `eip155:137` (Polygon) | USDC | `0x3c499c542cef5e3811e1192ce70d8cc03d5c3359` | `exact` |
| `eip155:42161` (Arbitrum) | USDC | `0xaf88d065e77c8cc2239327c5edb3a432268e5831` | `exact` |
| `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (Solana mainnet) | USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `exact` |
| `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (Solana mainnet) | EURC | `HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr` | `exact` |

The Solana network identifier is the **canonical CAIP-2 mainnet
genesis-hash form** per the x402 spec and live Bazaar responses, NOT
`solana:mainnet`. `signer-solana` produces payloads against this exact
identifier; the adapter rejects `solana:mainnet` and other variants.

Capabilities are registered with the orchestrator at adapter
construction time and refreshed from CDP's `/supported` endpoint by
the `CapabilityDiscoveryCron`. CDP's `/supported` returns `(scheme,
network)` pairs only — assets are joined from the static
configuration.

## Authentication

CDP requires every request to carry `Authorization: Bearer <jwt>`
where the JWT is EdDSA-signed per
<https://docs.cdp.coinbase.com/get-started/authentication/jwt-authentication>.
The adapter constructs that header internally via `jose`. Credentials
come from two environment variables read at boot:

| Env var | Purpose |
|---|---|
| `COINBASE_CDP_API_KEY_NAME` | Key id (e.g. `organizations/.../apiKeys/...`). |
| `COINBASE_CDP_API_KEY_SECRET` | Multi-line base64 EdDSA private key. |

If either is unset, `apps/api` skips CDP registration entirely — the
gateway boots without CDP coverage rather than crashing.

## Wire shapes per network

The adapter does NOT inspect or transform the `paymentPayload`
contents — that's CDP's job. The shapes the upstream signers produce:

- **EVM (`exact`)**: `payload.signature` + `payload.authorization`
  (EIP-3009 transferWithAuthorization).
- **Solana (`exact`)**: `payload.transaction` — base64-encoded
  partially-signed versioned Solana transaction (the facilitator
  fills in the feePayer signature and submits).

CDP's `/verify` and `/settle` accept both shapes against their
respective `paymentRequirements.network`.

## Tests

```bash
pnpm --filter @suverse-pay/adapter-coinbase-cdp test
```

57 tests across four files. Includes a dedicated Solana suite
(`describe("CoinbaseCdpAdapter Solana support")`) that exercises:

- `supports()` accepts the canonical Solana CAIP-2 and rejects the
  legacy `solana:mainnet` shorthand.
- `verify()` forwards an SVM-shaped payload (`{transaction: <base64>}`)
  and `extra.feePayer` to CDP verbatim.
- `settle()` returns CDP's base58 Solana transaction signature
  unchanged (no `0x`-prefixing).
- `discoverCapabilities()` cross-joins discovered Solana entries with
  the configured mint.
- Solana-specific failure reasons (`broadcast_failed`) propagate
  through the orchestrator error contract.

## Real-network smoke

**Deferred to Phase 3 Sub-task 4** — requires a CDP API key (see
`STATUS.md` for status). Today the adapter wiring is verified via
mocked CDP responses; the EVM signing math is verified by
`signer-evm`'s `recoverTypedDataAddress` round-trip; the Solana
signing math is verified by `signer-solana`'s
`nacl.sign.detached.verify` round-trip. None of those prove a
particular `(name, version, contract)` triple lands on-chain — that's
what real CDP smoke against Base Sepolia / Solana mainnet will
establish in Sub-task 4.

## CDP rate limits

Free tier: 1000 settled payments / month / API key. After that,
`$0.001` per settlement. The adapter tracks usage in Redis via
`RedisUsageTracker` and refuses to settle once
`COINBASE_CDP_MONTHLY_HARD_CAP` (default 5000) is reached, surfacing
`{ supported: false, reason: "quota_exceeded" }` from `supports()`.
