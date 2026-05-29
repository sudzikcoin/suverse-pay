# @suverse-pay/adapter-thirdweb-x402

`ProviderAdapter` implementation wrapping Thirdweb's **Nexus** x402
facilitator. Adds Optimism and ~20 other EVM L1/L2s to the suverse-pay
gateway in a single integration without writing per-network code, on
top of the existing CDP and PayAI adapters.

Design background lives at
`docs/design/non-cdp-evm-adapter.md` — option A in that doc.

## What this gives the gateway

Thirdweb advertises one of the broadest x402 facilitator footprints
today. Live `/supported` snapshot (2026-05-29) — every entry uses
`scheme: "exact"` with EIP-3009 USDC unless flagged otherwise:

| Network         | CAIP-2          | Asset                                                  | EIP-712 primaryType          |
| --------------- | --------------- | ------------------------------------------------------ | ---------------------------- |
| Ethereum        | `eip155:1`      | `0xA0b8…eB48` Circle USDC                              | `TransferWithAuthorization`  |
| Optimism        | `eip155:10`     | `0x0b2C…Ff85` Circle USDC                              | `TransferWithAuthorization`  |
| Flare           | `eip155:14`     | `0xd996…37cf` USDC                                     | `TransferWithAuthorization`  |
| XDC             | `eip155:50`     | `0xfA29…8eb1` USDC                                     | `TransferWithAuthorization`  |
| Polygon         | `eip155:137`    | `0x3c49…3359` Circle USDC                              | `TransferWithAuthorization`  |
| Monad mainnet   | `eip155:143`    | `0x7547…b603` USDC                                     | `TransferWithAuthorization`  |
| Sonic           | `eip155:146`    | `0x2921…8894` USDC                                     | `TransferWithAuthorization`  |
| World Chain     | `eip155:480`    | `0x79A0…24D1` USDC                                     | `TransferWithAuthorization`  |
| Sei mainnet     | `eip155:1329`   | `0xe15f…2392` USDC                                     | `TransferWithAuthorization`  |
| Gravity         | `eip155:1776`   | `0xa00C…235a` Circle USDC                              | `TransferWithAuthorization`  |
| Abstract        | `eip155:2741`   | `0x84A7…87e1` Bridged USDC (Stargate)                  | `TransferWithAuthorization`  |
| Peaq            | `eip155:3338`   | `0xbbA6…3d10` USDC                                     | **`Permit` (EIP-2612)**      |
| IoTeX           | `eip155:4689`   | `0xcdf7…3542` Bridged USDC                             | `TransferWithAuthorization`  |
| Ham             | `eip155:5112`   | `0xb883…630f` USDC                                     | `TransferWithAuthorization`  |
| Base            | `eip155:8453`   | `0x8335…2913` Circle USDC                              | `TransferWithAuthorization`  |
| Arbitrum One    | `eip155:42161`  | `0xaf88…5831` Circle USDC                              | `TransferWithAuthorization`  |
| Celo            | `eip155:42220`  | `0xceBA…118C` USDC                                     | `TransferWithAuthorization`  |
| Avalanche       | `eip155:43114`  | `0xB97E…8a6E` Circle USDC                              | `TransferWithAuthorization`  |
| Ink             | `eip155:57073`  | `0x2D27…EAEd` USDC                                     | `TransferWithAuthorization`  |
| Linea           | `eip155:59144`  | `0x1762…E1ff` USDC                                     | `TransferWithAuthorization`  |
| Solana mainnet  | `solana:5eykt…` | `EPjFW…TDt1v` Circle USDC mint (advertised via Thirdweb) | n/a |

Plus standard test networks (Sepolias, Avalanche Fuji, Base Sepolia,
Arbitrum Sepolia, etc.).

Networks the design doc flagged as targets:

- **Optimism (eip155:10)** — supported ✓
- **Avalanche (eip155:43114)** — supported ✓ (PayAI also has this)
- **BNB Chain (eip155:56)** — NOT supported by Thirdweb. Binance's own
  x402 facilitator remains the route if/when that becomes a priority.

## Permit (EIP-2612) limitation

A handful of networks advertise `primaryType: "Permit"` instead of
`TransferWithAuthorization` (Peaq mainnet, Berachain testnet). Our
`@suverse-pay/signer-evm` produces EIP-3009 signatures only — Permit
signing is a separate sub-task with its own design — so operators
should NOT add Permit-only networks to the static capability config.
The adapter's `discoverCapabilities()` accepts them but skips them
unless an operator has explicitly enabled them at registration.

## Authentication

| Endpoint     | Auth required | Default header        |
| ------------ | ------------- | --------------------- |
| `GET /supported`  | No (open)     | —                     |
| `GET /health`     | No (open)     | —                     |
| `POST /verify`    | **Yes**       | `x-nexus-key: <key>`  |
| `POST /settle`    | **Yes**       | `x-nexus-key: <key>`  |

`/supported` and `/health` being open means the adapter registers
correctly and runs capability discovery / health checks without
needing credentials. `/verify` and `/settle` need an API key
(currently sent as `x-nexus-key` for the public Nexus surface).

Thirdweb runs a second surface at
`https://api.thirdweb.com/v1/payments/x402` that uses `x-secret-key`
(the unified Thirdweb client secret) instead. Operators who want that
surface can configure:

```ts
new ThirdwebX402Adapter({
  baseUrl: "https://api.thirdweb.com/v1/payments/x402",
  authHeaderName: "x-secret-key",
  apiKey: process.env.THIRDWEB_SECRET_KEY,
  // ...
});
```

Both header name and base URL are overridable; the default (`nexus-api`
+ `x-nexus-key`) keeps the open-access path working out of the box.

## Wire shape

Verify / settle bodies are canonical x402 v2 — same shape Coinbase CDP
(modulo the CDP envelope) and PayAI accept:

```json
{
  "x402Version": 1,
  "paymentPayload": { ... },
  "paymentRequirements": { ... }
}
```

`x402Version` is forwarded verbatim from the payment payload Bazaar /
the merchant sent; Thirdweb's `/supported` advertises everything as
v1 even though `network` uses CAIP-2 (which the x402 spec normally
ties to v2). No envelope translation is needed.

`/settle` additionally accepts an optional `waitUntil` field —
`"simulated" | "submitted" | "confirmed"` (server default: confirmed).
Set via the `waitUntil` config option when you want to trade
confirmation latency for response latency.

## Configuration example

```ts
import { ThirdwebX402Adapter } from "@suverse-pay/adapter-thirdweb-x402";

const adapter = new ThirdwebX402Adapter({
  apiKey: process.env.THIRDWEB_X402_API_KEY, // sent as x-nexus-key
  capabilities: [
    { network: "eip155:10",    asset: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", scheme: "exact" }, // Optimism USDC
    { network: "eip155:43114", asset: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", scheme: "exact" }, // Avalanche USDC
    // ...
  ],
  estimatedFeeUsd: "0.001",
  // optional:
  // baseUrl: "https://nexus-api.thirdweb.com", // default
  // waitUntil: "submitted",                     // default: undefined (server uses "confirmed")
});
```

## What this adapter intentionally does NOT do

- **EIP-2612 (Permit) signing.** Phase 4 follow-on. Adapter accepts
  Permit entries from /supported but the signer doesn't produce them.
- **`/accepts` quote endpoint.** Thirdweb exposes a /accepts endpoint
  for facilitator-side pricing; the gateway uses synthetic quotes
  from static fee config so this stays unused for now.
- **`/list` route enumeration.** Not used by the gateway.
- **CDP's monthly hard-cap pattern.** Thirdweb's pricing model is
  tied to their Server Wallets product, not a flat monthly settle
  count, so the CDP-style per-month tracker doesn't apply. If
  Thirdweb publishes a per-key quota we'll add a tracker then.

## Status

- Phase 4 Block 1 Sub-task 3.
- Wire schemas + adapter methods + capability discovery + health checks.
- Unit tests cover happy paths, error mapping, retry/idempotency, header
  configurability, and `/supported` quirks (v1 labels + CAIP-2 networks,
  Permit entries skipped at static-config layer).
- Real `/supported` integration test caches the live response to
  `test-fixtures/thirdweb-supported.json` and asserts Optimism +
  Avalanche entries are present. Skips silently if Thirdweb is down.
- Real settle smoke (one Thirdweb-only network) deferred to a follow-up
  sub-task once API key procurement + signer EIP-3009 verification for
  each new network is wired through.
