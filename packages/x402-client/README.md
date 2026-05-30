# @suverselabs/x402-client

Unified buyer SDK for the x402 payment protocol. One client, one config —
pays any seller across 21+ networks (18 EVM mainnets + Cosmos Noble +
Solana + TRON, plus their testnets) through a single `fetch`-style API.

```ts
import { SuverseClient } from "@suverselabs/x402-client";

const client = new SuverseClient({
  wallets: {
    evm: "0x<private-key>", // covers ALL 18 EVM mainnets
    // future: solana, cosmos, tron — see "Status" below
  },
});

const { data, payment } = await client.fetch(
  "https://agentos.suverse.io/v1/freight/parse_ratecon",
);

console.log(payment.network, payment.txHash, payment.amount);
// → "eip155:8453"  "0x82f4..."  "70000"
```

## Why a buyer-side SDK?

x402 lets a seller return `HTTP 402 Payment Required` with a structured
challenge that lists which (network, scheme) pairs they accept. Any
buyer who can produce a signed payment for ONE of those pairs gets
through. In practice the matching + signing logic is repeated across
every agent that pays anything — viem here, `@solana/web3.js` there,
`@cosmjs` for Cosmos, custom for TRON. `@suverselabs/x402-client`
collapses that to one config block.

The default facilitator is `https://facilitator.suverse.io` (the
suverse-pay gateway), but the client is facilitator-agnostic — pass
any URL that implements the x402 v2 spec.

## Install

```bash
npm install @suverselabs/x402-client
```

## Status (v0.1.0)

| VM family | Networks | Implementation |
| --- | --- | --- |
| **EVM** | Ethereum (1), Optimism (10), XDC (50), Polygon (137), Sonic (146), World Chain (480), Sei (1329), Abstract (2741), IoTeX (4689), World Sepolia (4801), Base (8453), Arbitrum (42161), Celo (42220), Avalanche Fuji (43113), Avalanche (43114), Monad (143), Ink (57073), Linea (59144), Base Sepolia (84532), Arbitrum Sepolia (421614) | ✅ ready — EIP-3009 `transferWithAuthorization` |
| **Solana** | mainnet + devnet (USDC + USDT) | ✅ ready — SPL `transferChecked` partial-sign, facilitator co-signs as fee payer |
| **Cosmos Noble** | `noble-1` mainnet + `grand-1` testnet | ✅ ready — ADR-036 sign of canonical Authorization JSON, scheme `exact_cosmos_authz` (pre-condition: payer must have run `MsgGrant{SendAuthorization}` to the facilitator grantee) |
| **TRON** | `mainnet` + `nile` testnet — **`exact_gasfree` only** | ⚠️ ready, experimental — TIP-712 PermitTransfer via gasfree.io relay; $1.50 USDT minimum; TIP-712 `verifyingContract` is a placeholder by default, pass `signerOptions.tron.gasfreeDomain.{mainnet,nile}` with the real gasfree.io contract before production. TRON `exact` + `exact_permit` schemes NOT in v0.1.0 (Tether USDT on TRON does not expose EIP-3009/EIP-2612 — no working pathway exists for those schemes today). |

> **Notes on excluded chains** (visible in `CHAINS` registry but signer refuses with `chain_not_eip3009`):
> - **BNB Chain (56)** — Binance-Peg USDC is 18-decimal EIP-2612 permit, route through Binance x402 adapter
> - **Tempo (4217)** — `version()` reverts on the deployed USDC; route through MPP / Stripe settlement
>
> **Solana wallet shapes** (v0.1.0): base58 secret key string OR `Uint8Array` (32-byte seed or 64-byte secret key). BIP-39 mnemonic input not included to avoid the bip39 + ed25519-hd-key deps; decode externally if you have one.
> **Recent blockhash** is auto-fetched from public RPC (`api.mainnet-beta.solana.com` / `api.devnet.solana.com`) on each sign. Pass `signerOptions.solana.rpcEndpoint` to use Helius / Triton / QuickNode in production.

The signing API is stable across families — adding a new wallet
config to an existing `SuverseClient` instance never requires changing
how you call `.fetch()`.

## Quick start — EVM only

```ts
import { SuverseClient } from "@suverselabs/x402-client";

const client = new SuverseClient({
  wallets: {
    evm: process.env.PRIVATE_KEY as `0x${string}`,
  },
});

try {
  const { data, payment } = await client.fetch(
    "https://api.example/paid-endpoint",
    {
      method: "POST",
      body: JSON.stringify({ q: "your input" }),
    },
  );
  console.log("paid on", payment.network, "tx", payment.txHash);
  console.log("response:", data);
} catch (err) {
  // ...
}
```

The same code pays the seller on whichever EVM chain ends up cheapest
(or whichever you marked `preferredNetwork`). The EVM private key
covers every EIP-3009-capable USDC contract we know about — there is
no per-chain configuration.

## Direct signing (no `fetch` wrapper)

If you already have the challenge body (e.g. you handle the HTTP
yourself), call `client.signFor()` to get just the `X-Payment` /
`PAYMENT-SIGNATURE` header value:

```ts
const headerValue = await client.signFor(challengeBody, {
  preferredNetwork: "eip155:8453",
});
const res = await fetch(url, { headers: { "X-Payment": headerValue } });
```

## Preferences

```ts
new SuverseClient({
  wallets: { evm: "0x..." },
  preferences: {
    preferredNetwork: "eip155:8453",          // try this first
    avoidNetworks: ["eip155:1"],              // never use Ethereum L1
    maxGasUsd: 0.50,                          // bail if our gas estimate exceeds
  },
});
```

Selection algorithm: intersection of (seller-accepted networks ∩
configured wallets) ∩ (not in `avoidNetworks`); apply
`preferredNetwork` first; otherwise rank by chain-class cost (Cosmos
Noble < Solana < L2 EVM < L1 EVM); TRON only chosen when amount
exceeds the `gasfree.io` minimum.

## Subpath imports

Each signer is importable directly when you want to keep the bundle
small or use the lower-level signing API:

```ts
import { EvmSigner } from "@suverselabs/x402-client/evm";
import { CHAINS, lookupByCaip2 } from "@suverselabs/x402-client/chains";
```

## License

Apache-2.0
