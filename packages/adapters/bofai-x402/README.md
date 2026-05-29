# @suverse-pay/adapter-bofai-x402

`ProviderAdapter` implementation wrapping BofAI's open x402
facilitator. Phase 4 Block 2 Sub-task 8.

This is the gateway's **first non-EVM, non-Solana, non-Cosmos** route
— TRON mainnet and TRON Nile testnet land alongside the existing EVM
networks. BofAI also covers BSC mainnet and BSC testnet, giving the
gateway a second adapter on BSC alongside Binance x402 (Sub-task 7).

## What this gives the gateway

Single facilitator, four networks, three schemes:

| Network | `exact` | `exact_permit` | `exact_gasfree` |
| --- | --- | --- | --- |
| `tron:mainnet` | ✓ | ✓ | ✓ |
| `tron:nile` (testnet) | ✓ | ✓ | ✓ |
| `eip155:56` (BSC mainnet) | ✓ | ✓ | — |
| `eip155:97` (BSC testnet) | ✓ | ✓ | — |

Source: live probe of `https://facilitator.bankofai.io/supported`
2026-05-29 (cached at `test-fixtures/bofai-supported.json`). GasFree
is TRON-only; BSC does not advertise it.

Strategic significance: **TRON USDT is the single largest USDT
deployment by volume globally** — Tether issues the majority of USDT
on TRON. Adding TRON coverage unlocks the largest agentic-payment
audience without exposing them to BSC-level decimal traps.

## Authentication

**Open / no auth required.** Per BofAI's CHANGELOG v0.6.0:

> GasFree API endpoints now route through the BankOfAI proxy — clients
> no longer need API keys or secrets.

The adapter sends no Authorization header on any call. Live-probed:
`/supported`, `/health`, `/verify`, `/settle` all accept POST/GET
without credentials (verify/settle return 422 on missing body fields
not 401).

For self-hosting: BofAI publishes a Docker-deployable facilitator
(see [BofAI/x402-demo](https://github.com/BofAI/x402-demo)). Point
the adapter at your self-host via `BOFAI_X402_BASE_URL` env var.

## Wire shape

Vanilla x402 v2 — same body the spec defines and what PayAI /
Thirdweb already accept:

```json
{
  "x402Version": 2,
  "paymentPayload": { ... },
  "paymentRequirements": { ... }
}
```

Response shapes mirror canonical x402 v2 facilitator vocabulary
(`{isValid, invalidReason, ...}` for verify;
`{success, transaction, errorReason, ...}` for settle).

## Schemes — what works today and what needs Phase 5

| Scheme | EIP-712/TIP-712 domain | Signer status |
| --- | --- | --- |
| `exact` (ERC-3009) | Token contract domain (`name`, `version` from token) | **Works on BSC today** — `@suverse-pay/signer-evm` already produces this. TRON requires a Phase 5 `signer-tron` (same TIP-712 math but TRON address derivation differs from EVM). |
| `exact_permit` | `PaymentPermit` contract domain (`name="PaymentPermit"`) | **Deferred to Phase 5.** Separate EIP-712 domain — neither `signer-evm` nor any other current signer produces this signature. |
| `exact_gasfree` | `GasFreeController` contract domain (`name="GasFreeController"`, `version="V1.0.0"`) | **Deferred to Phase 5.** TRON-only. Requires `signer-tron` + the GasFree custodial wallet flow (user activates a `gasFreeAddress`, signs PermitTransfer messages, relayer pays gas). |

> **Important:** the adapter forwards verify + settle requests for
> all three schemes — it does not gate on the signer's capabilities.
> The orchestrator routes paymentPayloads built by whatever signer the
> caller uses. If the caller can produce TIP-712 signatures for TRON,
> the adapter is the path. The Phase 5 native `signer-tron` is what
> unlocks first-party signing within the gateway.

## Configuration

```ts
import { BofaiX402Adapter, TRON_TOKENS } from "@suverse-pay/adapter-bofai-x402";

const adapter = new BofaiX402Adapter({
  // baseUrl: "https://facilitator.bankofai.io",  // default
  estimatedFeeUsd: "0.001",
  capabilities: [
    // TRON mainnet — USDT, all three schemes BofAI advertises
    { network: "tron:mainnet", asset: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", scheme: "exact" },
    { network: "tron:mainnet", asset: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", scheme: "exact_permit" },
    { network: "tron:mainnet", asset: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", scheme: "exact_gasfree" },
    // TRON Nile testnet — primary smoke target per BofAI's e2e suite
    { network: "tron:nile", asset: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", scheme: "exact" },
    { network: "tron:nile", asset: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", scheme: "exact_permit" },
    { network: "tron:nile", asset: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", scheme: "exact_gasfree" },
    // BSC mainnet — USDC + USDT, exact + exact_permit. The gateway
    // routes BSC primary through Binance x402 (Sub-task 7) with BofAI
    // as failover.
    { network: "eip155:56", asset: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", scheme: "exact" },
    { network: "eip155:56", asset: "0x55d398326f99059fF775485246999027B3197955", scheme: "exact" },
  ],
});
```

## TRON address handling

TRON uses Base58Check addresses with a `T` prefix, 34 characters
long (e.g. `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`). The on-chain
representation is hex-prefixed with `41` (TRON's chain identifier
byte) — the EVM equivalent is the same hex with `41` swapped for
`0x`. The adapter passes the Base58 form verbatim in
`PaymentRequirements.asset`; no conversion is performed.

`tron-tokens.ts` carries the small TRON token registry the adapter
references (USDT on mainnet/Shasta/Nile, all 6 decimals). When the
Phase 5 `signer-tron` lands, this registry migrates to that package.

## Maturity signals

- **BofAI repo last commit**: very active, with CHANGELOG entries
  through v0.6.0 (TypeScript parity). TRON Nile + BSC testnet smoke
  validated 2026-04-03.
- **Hosted facilitator uptime**: `/health` returned 200 immediately
  on probe; uptime monitoring isn't published.
- **Open source**: Apache-2.0, Python + TypeScript SDKs in monorepo.
- **Production use**: BofAI is the only major TRON-on-x402 path; the
  alternatives are self-host or wait for an upstream Coinbase/CDP
  TRON facilitator (no public roadmap for that).

## Status

| Aspect | State |
| --- | --- |
| Wire schemas + adapter methods | ✓ implemented |
| `/supported` integration test | ✓ live probe + cached fixture |
| Unit tests | ✓ mocked verify + settle + discovery + error mapping |
| BSC routing failover | ✓ wired (Binance primary, BofAI failover) |
| TRON routing | ✓ wired (BofAI sole adapter for `tron:*`) |
| `signer-tron` for TRON-side signing | ✗ Phase 5 |
| `exact_permit` signer | ✗ Phase 5 |
| `exact_gasfree` signer + GasFree custodial flow | ✗ Phase 5 |
| Real on-chain smoke through this gateway | ✗ Phase 5 |
