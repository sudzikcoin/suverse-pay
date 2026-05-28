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
| `eip155:84532` (Base Sepolia) | USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `exact` |
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

The adapter does NOT inspect or transform the `paymentPayload.payload`
contents — that's CDP's job. The shapes the upstream signers produce:

- **EVM (`exact`)**: `payload.signature` + `payload.authorization`
  (EIP-3009 transferWithAuthorization).
- **Solana (`exact`)**: `payload.transaction` — base64-encoded
  partially-signed versioned Solana transaction (the facilitator
  fills in the feePayer signature and submits).

CDP's `/verify` and `/settle` accept both shapes against their
respective `paymentRequirements.network`.

### CDP-specific envelope translation

CDP's hosted facilitator implements **`x402V2PaymentRequirements`
with `amount`** (not the spec's `maxAmountRequired`) AND requires an
**`accepted`** field embedded inside the `paymentPayload` carrying
the same requirements. The rest of the codebase uses canonical x402
spec field names; this adapter does the translation in
`toCdpRequest`. Verified empirically on `api.cdp.coinbase.com`
(2026-05-28): sending the spec shape returns HTTP 400 with
`x402V2PaymentPayload requires 'accepted'` /
`x402V2PaymentRequirements requires 'amount'`. The unit test
`translates the spec wire format to CDP's internal x402V2 shape`
guards against silent regression.

## Tests

```bash
pnpm --filter @suverse-pay/adapter-coinbase-cdp test
```

58 tests across four files. Includes a dedicated Solana suite
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

**Closed in v0.3.1** — see `scripts/smoke/real-evm/`. The 7-step
suite signs an EIP-3009 `transferWithAuthorization` for Base Sepolia
USDC via the test wallet at `.env.evm-sepolia` (mode 600, gitignored)
and posts it to both the internal `/settle` path and the public
`/facilitator/settle` path. Each step asserts the on-chain receipt
status (`eth_getTransactionReceipt`) is `0x1`. Inaugural real Base
Sepolia tx via this adapter:
[`0x618913...c74abfd`](https://sepolia.basescan.org/tx/0x618913f76b23878b2d0db3cba83c9073f45371ff790e972c240f5771bc74abfd).

Solana mainnet real-smoke remains deferred (would cost real money on
each run); the EVM closure here is the harder of the two because the
adapter does the EIP-712 domain join and now-validated CDP wire
translation.

## CDP rate limits

Free tier: 1000 settled payments / month / API key. After that,
`$0.001` per settlement. The adapter tracks usage in Redis via
`RedisUsageTracker` and refuses to settle once
`COINBASE_CDP_MONTHLY_HARD_CAP` (default 5000) is reached, surfacing
`{ supported: false, reason: "quota_exceeded" }` from `supports()`.
