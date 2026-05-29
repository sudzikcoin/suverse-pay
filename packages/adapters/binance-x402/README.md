# @suverse-pay/adapter-binance-x402

`ProviderAdapter` implementation wrapping Binance's x402 facilitator
on BNB Chain. Phase 4 Block 2 Sub-task 7 — the only adapter route to
`eip155:56` in the gateway (CDP, PayAI, and Thirdweb don't advertise
BNB Chain on x402).

## Status (2026-05-29)

| Aspect | State |
| --- | --- |
| Wire schemas + adapter methods | ✓ implemented |
| Auth (Binance Pay HMAC-SHA512) | ✓ implemented per `binance/binance-pay-signature-examples` |
| Unit tests | ✓ mocked verify + settle + auth + capability discovery |
| Real `/supported` probe | ✗ Binance has not published a public x402 endpoint as of this commit; `x402.binance.com` and `www.binance.com/en/x402` are gated behind CloudFront WAF and redirect/challenge unauthenticated requests |
| Real settle smoke | ✗ deferred — requires Binance Pay merchant onboarding (no self-serve API key flow at launch) |
| BNB Chain USDC + USDT signer entries | ✓ added to `signer-evm` `usdt-tokens.ts` (18 decimals — confirmed on-chain) |
| Permit2 + x402ExactPermit2Proxy on BSC | ✓ both deployed (verified via `bsc-dataseed.binance.org` `eth_getCode`) |

## What this gives the gateway

Single facilitator route to BNB Chain. Binance's announcement
(2026-05-19) lists supported stablecoins: **U**, **USDT**, **USD1**,
**USDC** — and supported authorization methods: **eip3009**,
**permit2-exact**, **permit2-upto**.

USDT and USDC live in `signer-evm` after Sub-task 6 (Permit2 path) +
Sub-task 7 (BSC entries); USD1 and U await registry entries once we
have addresses + on-chain `name()`/`decimals()` for them.

> **Critical: BNB Chain stablecoin decimals = 18, not 6.**
> Every other USDC/USDT route in this gateway is 6-decimal. Code that
> formats amounts MUST read `decimals` from the registry entry — see
> `signer-evm/src/usdt-tokens.ts`. Hard-coding `1e6` silently
> under-charges by 12 orders of magnitude.

## Authentication

Binance x402 is a Binance Pay product and reuses the merchant API
auth scheme:

```
Headers on every signed request:
  Content-Type: application/json
  Accept: application/json
  BinancePay-Timestamp: <unix milliseconds>
  BinancePay-Nonce: <random 32-char alphanumeric>
  BinancePay-Certificate-SN: <merchant api key id>
  BinancePay-Signature: HMAC_SHA512(secret,
    `${timestamp}\n${nonce}\n${JSON.stringify(body)}\n`).hex.toUpperCase()
```

Implementation: `src/auth.ts` `buildBinanceAuthHeaders`. The adapter
auto-signs every `/verify` and `/settle` call when credentials are
present; absent credentials it throws `ProviderError("unauthorized")`
with a clear message rather than emitting an unsigned request.

`GET /supported` and `GET /health` also require auth on the Binance
Pay surface; the adapter's `discoverCapabilities()` surfaces a clear
"credentials required" error when keys are missing, and
`healthCheck()` attempts an unauthenticated GET and reports `down` if
the server rejects it (so operators see at a glance whether keys are
configured).

Env vars (consumed by `apps/api`):

- `BINANCE_X402_API_KEY` — `BinancePay-Certificate-SN`.
- `BINANCE_X402_API_SECRET` — HMAC-SHA512 key.
- `BINANCE_X402_BASE_URL` — defaults to `https://bpay.binanceapi.com`.
- `BINANCE_X402_PATH_PREFIX` — defaults to
  `/binancepay/openapi/v1/x402`. Override once Binance publishes the
  exact x402 mount point on the merchant API.
- `BINANCE_X402_ENABLED` — defaults to `true`. Set to `false` to skip
  registration entirely.

## Wire shape (assumed canonical x402 v2)

Binance's announcement endorses `eip3009`, `permit2-exact`, and
`permit2-upto` — all standard x402 schemes — so we send vanilla x402
v2 bodies:

```json
{
  "x402Version": 2,
  "paymentPayload": { ... },
  "paymentRequirements": { ... }
}
```

If Binance's production wire format diverges, the deviation gets
captured in `src/wire.ts` and the adapter translates (same pattern as
the CDP envelope handling).

## Asset configuration

Operators register the adapter in `apps/api/src/index.ts` with the
list of (network, asset) tuples Binance covers:

```ts
const binanceCaps = [
  // BNB Chain mainnet — 18-decimal stablecoins
  { network: "eip155:56", asset: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", scheme: "exact", assetTransferMethod: "permit2-exact" }, // USDC (Binance-Peg, 18 decimals)
  { network: "eip155:56", asset: "0x55d398326f99059fF775485246999027B3197955", scheme: "exact", assetTransferMethod: "permit2-exact" }, // USDT (Binance-Peg, 18 decimals)
] as const;
```

USD1 and U get added once we have on-chain contract addresses.

## What this adapter intentionally does NOT do

- **EIP-3009 path for BNB Chain USDC**: BSC USDC (Binance-Peg) does
  NOT expose `version()` — i.e. it's not the canonical Circle
  EIP-3009 deployment. Routing it as `eip3009` would fail at signing
  time. Permit2 is the universal path.
- **Real on-chain settle smoke**: needs Binance Pay merchant
  onboarding. Phase 5.
- **USD1 / U token entries**: addresses not yet sourced. Add to
  `signer-evm/src/usdt-tokens.ts` when known.

## Why a separate adapter

Binance x402 isn't reachable through any of the existing adapters:

- Coinbase CDP `/supported`: no `eip155:56` entries (verified
  Sub-task 1).
- PayAI `/supported`: no `eip155:56` entries (verified Sub-task 2).
- Thirdweb Nexus `/supported`: no `eip155:56` entries (verified
  Sub-task 3 fixture, re-checked Sub-task 5).

Binance gates BNB Chain x402 through their own facilitator. The
gateway needs a dedicated adapter to reach it.
