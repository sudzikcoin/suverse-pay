# @suverselabs/x402-client

[![npm](https://img.shields.io/npm/v/@suverselabs/x402-client?label=npm&color=4f46e5)](https://www.npmjs.com/package/@suverselabs/x402-client)
[![license](https://img.shields.io/npm/l/@suverselabs/x402-client?color=4f46e5)](./LICENSE)

Unified **buyer-side** SDK for the [x402 payment protocol](https://x402.org).
One client, one config — pays any seller across **23 networks** spanning
four virtual machines: EVM (18 mainnets + 3 testnets), Solana, Cosmos
Noble, and TRON.

```ts
import { SuverseClient } from "@suverselabs/x402-client";

const client = new SuverseClient({
  wallets: { evm: process.env.PRIVATE_KEY as `0x${string}` },
});

const { data, response, payment } = await client.fetch(
  "https://agentos.suverse.io/v1/freight/parse_ratecon",
  { method: "POST", body: JSON.stringify({ text: "..." }) },
);

console.log(response.status);                                  // 200
console.log(payment.network, payment.txHash, payment.amount);
// → "eip155:8453"  "0x82f4..."  "70000"
console.log(data);                                              // parsed body
```

The client handles 402 challenges automatically: pick the cheapest
network the seller accepts that intersects with the wallets you
configured, sign the right payload for that VM, retry. You write
`client.fetch(url)`; the multi-chain plumbing is gone.

## Install

```bash
npm install @suverselabs/x402-client
```

Requires Node 20+. Runtime deps:
[viem](https://viem.sh) (EVM + TRON typed-data),
`@solana/web3.js` + `@solana/spl-token` (SVM),
`@cosmjs/{crypto,encoding,amino}` (Cosmos),
`bs58` + `bs58check` (base58/base58check codecs).

## Supported networks (v0.1.0)

### EVM (18 mainnets + 3 testnets) — `scheme: "exact"` (EIP-3009)

The same private key signs for every chain in this table. EIP-712
`name`/`version`/`verifyingContract` per chain are vendored from
on-chain `eth_call name() / version()` probes — see [`chains.ts`](./src/network/chains.ts).

| chain | CAIP-2 | USDC contract | notes |
| --- | --- | --- | --- |
| Base | `eip155:8453` | `0x833589fC…02913` | recommended for first integration |
| Optimism | `eip155:10` | `0x0b2C639c…0Ff85` |
| Arbitrum | `eip155:42161` | `0xaf88d065…e5831` |
| Polygon | `eip155:137` | `0x3c499c54…c3359` | gas in MATIC |
| World Chain | `eip155:480` | `0x79A02482…761d4d1` |
| Avalanche C-Chain | `eip155:43114` | `0xB97EF9Ef…6Bc66Dd9c48a6E` |
| Celo | `eip155:42220` | `0xcebA9300…32118C` |
| Linea | `eip155:59144` | `0x176211869…2821ee1ff` |
| Ink | `eip155:57073` | `0x2D270e688…AEd` |
| XDC | `eip155:50` | `0xfA2958CB…eb1` |
| Monad | `eip155:143` | `0x754704Bc…603` |
| Sonic | `eip155:146` | `0x29219dd4…894` |
| Sei | `eip155:1329` | `0xe15fc38f…392` |
| Abstract | `eip155:2741` | `0x84A71ccD…e1` | `Bridged USDC (Stargate)` |
| IoTeX | `eip155:4689` | `0xcdf79194…42` | `Bridged USDC` |
| Ethereum | `eip155:1` | `0xA0b86991…eB48` | L1, expensive — last by cost rank |
| Base Sepolia | `eip155:84532` | `0x036CbD53…7e` | testnet |
| Arbitrum Sepolia | `eip155:421614` | `0x75faf114…d` | testnet |
| Avalanche Fuji | `eip155:43113` | `0x5425890298…1Bc65` | testnet |

#### Excluded chains (signer **refuses** with `chain_not_eip3009`):

- **BNB Chain (56)** — Binance-Peg USDC is 18-decimal EIP-2612 permit, not EIP-3009. Use BofAI's permit pathway through the seller's facilitator.
- **Tempo (4217)** — `version()` reverts on the deployed USDC; settle via MPP / Stripe instead.

### Solana — `scheme: "exact"` (SPL `transferChecked`)

| network | CAIP-2 | tokens |
| --- | --- | --- |
| Mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | USDC (`EPjFWdd5…Dt1v`), USDT (`Es9vMFrz…NYB`) |
| Devnet | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | USDC test (`4zMMC9srt…cDU`) |

Buyer partial-signs a `VersionedTransaction` (ComputeBudget×2 +
`transferChecked` + Memo). The facilitator co-signs as `feePayer` and
submits — buyer never spends SOL.

### Cosmos — `scheme: "exact_cosmos_authz"` (ADR-036)

| network | CAIP-2 | denom | bech32 prefix |
| --- | --- | --- | --- |
| Noble mainnet | `cosmos:noble-1` | `uusdc` (6dp) | `noble` |
| Noble testnet | `cosmos:grand-1` | `uusdc` (6dp) | `noble` |

**Pre-condition:** the payer must run `MsgGrant{SendAuthorization}`
on-chain to the facilitator grantee BEFORE any payment can verify.
The signer just produces the signed authorization; the facilitator
queries the grant at verify time and rejects without one.

### TRON — `scheme: "exact_gasfree"` ONLY in v0.1.0 ⚠️ experimental

| network | CAIP-2 | tokens |
| --- | --- | --- |
| Mainnet | `tron:mainnet` | USDT (`TR7NHqje…Lj6t`) |
| Nile testnet | `tron:nile` | USDT (`TXYZopYR…NeBf`) |

The buyer signs a TIP-712 PermitTransfer authorisation that
gasfree.io's relayer executes, paying gas in USDT on the buyer's
behalf.

**Constraints:**
- **$1.50 USDT minimum** (gasfree.io relayer rejects below this).
- **gasfree.io contract address is a placeholder by default** — pass
  `signerOptions.tron.gasfreeDomain.{mainnet,nile}` with the real
  `verifyingContract` before production. The signer refuses to sign
  against the placeholder.
- **`exact` + `exact_permit` schemes NOT in v0.1.0** — Tether USDT
  on TRON doesn't expose EIP-3009 or EIP-2612. Routing layer filters
  TRON candidates to `exact_gasfree` only; if the seller advertises
  ONLY `exact` on TRON, the client throws `NoSupportedNetworkError`.

## Multi-chain example

```ts
import { SuverseClient } from "@suverselabs/x402-client";

const client = new SuverseClient({
  wallets: {
    evm: process.env.EVM_PRIVATE_KEY as `0x${string}`,
    solana: process.env.SOLANA_SECRET_BASE58!,       // bs58(64-byte secret)
    cosmos: process.env.COSMOS_MNEMONIC!,             // 12 or 24 BIP-39 words
    tron: process.env.TRON_PRIVATE_KEY as `0x${string}`,
  },
  preferences: {
    preferredNetwork: "cosmos:noble-1",    // try Cosmos first
    avoidNetworks: ["eip155:1"],            // skip Ethereum L1
  },
  signerOptions: {
    solana: { rpcEndpoint: "https://your-helius-endpoint.com" },
    tron: {
      gasfreeDomain: {
        mainnet: {
          name: "GasFree",
          version: "V1.0.0",
          chainId: 728126428,
          verifyingContract: "0xYOUR_GASFREE_CONTRACT",
        },
      },
    },
  },
});

const { data, response, payment } = await client.fetch(
  "https://agentos.suverse.io/v1/freight/parse_ratecon",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "rate confirmation contents..." }),
  },
);

console.log(`HTTP ${response.status} — paid on ${payment.network} for ${payment.amount}`);
console.log(`tx: ${payment.txHash}`);
console.log("response body:", data);
```

## Network selection

Selection algorithm (when multiple options are viable):

1. Filter sellers' `accepts` against:
   - which wallets you configured (`wallets.*`)
   - `avoidNetworks` blacklist
   - per-network feasibility (EIP-3009 capability for EVM,
     `exact_gasfree` for TRON, `$1.50` minimum on TRON, etc.)
2. If `preferredNetwork` is in the surviving set → take it.
3. Otherwise rank by cost class and take the cheapest:
   1. `cosmos:noble-1` (sub-cent gas)
   2. `solana:*` (sub-cent gas)
   3. `tron:*` (relayer-sponsored, but ≥$1.50)
   4. EVM L2 (Base, Arbitrum, Optimism, …)
   5. EVM L1 (Ethereum) — multi-dollar gas
   6. Testnets — last resort

## API reference

### `new SuverseClient(options)`

```ts
interface SuverseClientOptions {
  wallets: {
    evm?: `0x${string}` | viem.LocalAccount;    // all 18 EVM mainnets + testnets
    solana?: string | Uint8Array;                // base58 secret OR seed bytes
    cosmos?: string | Uint8Array;                // BIP-39 mnemonic OR 32-byte privkey
    tron?: `0x${string}`;                        // EVM-style hex privkey
  };
  defaultFacilitator?: string;                   // default https://facilitator.suverse.io
  preferences?: {
    preferredNetwork?: string;
    avoidNetworks?: string[];
    maxGasUsd?: number;
  };
  fetchImpl?: typeof fetch;                      // test injection
  signerOptions?: {
    solana?: { rpcEndpoint?: string; computeUnitPriceMicroLamports?: number; ... };
    cosmos?: { validitySeconds?: number };
    tron?: { gasfreeDomain?: { mainnet?: GasfreeDomain; nile?: GasfreeDomain }; ... };
  };
}
```

### `client.fetch<T>(url, init?)`

Drop-in replacement for `fetch`. On a 200 response, returns the body
verbatim. On a 402, parses the challenge, picks a network, signs,
retries with `PAYMENT-SIGNATURE` + `X-PAYMENT` headers attached.

```ts
const { data, response, payment } = await client.fetch<MyResponseType>(url, init);
```

`payment` is a `PaymentReceipt`:

```ts
interface PaymentReceipt {
  network: string;       // e.g. "eip155:8453"
  scheme: string;        // e.g. "exact"
  asset: string;         // contract / mint / denom
  amount: string;        // atomic units
  payer: string;         // buyer's address in network-native format
  payTo: string;         // seller's address
  txHash: string | null; // null when verify-only or PAYMENT-RESPONSE absent
}
```

### `client.pay(challenge, prefs?)` / `client.signFor(challenge, prefs?)`

When you handle the HTTP yourself and want just the header value:

```ts
const challenge = await parseSellerChallenge(response);
const headerValue = await client.pay(challenge);

const retry = await fetch(url, {
  headers: { "X-Payment": headerValue, "PAYMENT-SIGNATURE": headerValue },
});
```

`.pay()` and `.signFor()` are aliases; pick whichever reads better.

### What `.fetch()` returns

`client.fetch<T>(url, init?)` resolves to a `FetchResult<T>` — **not**
a raw `Response`. The three fields are:

```ts
interface FetchResult<T> {
  data: T;             // parsed body (JSON if Content-Type JSON, else text)
  response: Response;  // the raw Response from the retried fetch
  payment: PaymentReceipt;  // what was paid, on which chain, txHash, …
}
```

So a common pitfall:

```ts
// ❌ wrong — these are undefined on FetchResult
const r = await client.fetch(url, init);
r.status;          // undefined
r.payment.txHash;  // ✓ but most users hit the line above first
await r.json();    // not a function — body is already parsed in `data`

// ✓ destructure
const { data, response, payment } = await client.fetch<MyShape>(url, init);
response.status;   // HTTP status from the retry
payment.txHash;    // settle tx hash (or null in verify-only mode)
data;              // already parsed
```

The `response` object is the same `Response` you'd get from native
`fetch`; use it when you need `.status`, `.headers`, `.ok`, etc.

### `client.signRequirement(requirement, options?)`

When you've already picked the network and just want the envelope:

```ts
const envelope = await client.signRequirement(requirement, {
  resource: "https://api.seller/paid",  // REQUIRED for Cosmos
});
```

The `resource` option is required for Cosmos networks (the URL is
part of the signed preimage). EVM / Solana / TRON ignore it.

### Lower-level signing

Each VM signer is exported standalone for advanced use:

```ts
import { EvmSigner, toHeaderValue as evmHeader } from "@suverselabs/x402-client/evm";
import { SolanaSigner } from "@suverselabs/x402-client/solana";
import { CosmosSigner, adr036Preimage } from "@suverselabs/x402-client/cosmos";
import { TronSigner } from "@suverselabs/x402-client/tron";

const signer = new EvmSigner({ wallet: "0x..." });
const envelope = await signer.sign({ requirement });
const header = evmHeader(envelope);
```

Subpath exports keep the bundle small if you only need one VM.

## Error catalog

All errors extend `X402ClientError` (which extends `Error`) and carry
a `.code` string. Common subclasses:

```ts
import {
  X402ClientError,
  NoSupportedNetworkError,
  InsufficientAmountError,
  FacilitatorRejectedError,
} from "@suverselabs/x402-client";
```

| code | thrown by | what it means | fix |
| --- | --- | --- | --- |
| `unexpected_status` | `.fetch()` | seller returned non-200 / non-402 | check seller URL + try again |
| `payment_retry_failed` | `.fetch()` | seller still rejected after signed retry | inspect retry's response body for the seller's reason |
| `invalid_challenge` | `.fetch()` / parser | 402 body or `PAYMENT-REQUIRED` header malformed | upgrade seller's middleware or contact them |
| `empty_challenge` | routing | `accepts` array empty | seller bug; not actionable client-side |
| `no_evm_wallet` / `no_solana_wallet` / `no_cosmos_wallet` / `no_tron_wallet` | `.fetch()` | seller requires VM family X, you didn't pass `wallets.x` | add the wallet to your config |
| `missing_resource` | `.signRequirement()` | Cosmos signer needs `options.resource` | pass `challenge.resource.url` (or use `.fetch()` / `.signFor()`) |
| `unsupported_chain` | each signer | network not in the SDK's registry | open an issue + pin a release that adds it |
| `unsupported_network_family` | client | network is `near:*` / `aptos:*` etc | use a different VM family |
| `scheme_mismatch` | EVM / Solana / Cosmos | challenge scheme isn't what the signer handles | check seller's challenge.scheme |
| `chain_not_eip3009` | EVM | BNB Chain / Tempo / similar | route through a Permit2 pathway instead |
| `not_evm_network` | EVM | `EvmSigner.sign` called with non-`eip155:*` | use the right signer |
| `domain_mismatch` | EVM | seller's `extra.{name,version}` disagrees with the trusted local USDC domain | flag the seller — possible spoof |
| `asset_mismatch` | EVM | requirement.asset isn't the canonical USDC contract for that chain | seller bug or wrong contract |
| `chain_id_mismatch` | Cosmos | `extra.chainId` disagrees with our registry | seller bug |
| `missing_facilitator` | Cosmos | `extra.facilitator` missing (grantee bech32) | seller bug |
| `missing_fee_payer` | Solana | `extra.feePayer` missing | seller bug |
| `fee_payer_collision` | Solana | `feePayer` equals source authority or ATA — spec violation | seller bug |
| `unknown_token` | TRON / Solana | mint / contract isn't in the SDK token registry | add `extra.decimals` (Solana) or open an issue (TRON) |
| `unknown_decimals` | Solana | mint not in registry AND `extra.decimals` not set | seller should set `extra.decimals` |
| `memo_too_long` | Solana | seller's `extra.memo` > 256 bytes | seller bug |
| `missing_gasfree_domain` | TRON | placeholder `verifyingContract` not overridden | pass real `signerOptions.tron.gasfreeDomain.{mainnet,nile}` |
| `scheme_not_implemented_v0_1_0` | TRON | seller advertised TRON `exact` or `exact_permit` | use `exact_gasfree` or wait for a later release |
| `invalid_wallet` | every signer | wallet format wrong for this VM | re-check the shape — see types in `SuverseClientOptions` |
| `invalid_validity` | every signer | `validitySeconds` ≤ 0 | use a positive integer |
| `invalid_cu_price` | Solana | CU price out of [1, 5_000_000] | see Solana spec cap |
| `invalid_max_fee` / `invalid_pubkey` / `invalid_tron_address` / `invalid_evm_address` | various | malformed address / value | sanity-check inputs |
| `blockhash_fetch_failed` | Solana | RPC unreachable | set `signerOptions.solana.rpcEndpoint` |
| `no_supported_network` | routing | intersection of seller's accepts ∩ your wallets ∩ avoidNetworks is empty | add a wallet, drop `avoidNetworks`, or check seller's offering |
| `insufficient_amount` | TRON | seller asks for less than gasfree.io's $1.50 USDT minimum | this challenge is unfulfillable on TRON; use another VM if seller offers one |
| `facilitator_rejected` | (future) | reserved for catching facilitator-side 4xx | inspect `.invalidReason` |

Every error message also includes a human-readable hint pointing at
the most likely fix. `.code` is the stable identifier — match on it
rather than the message text in production code.

## Examples

Runnable examples live in [`examples/`](./examples/). Each one is a
single TypeScript file with the env-var prerequisites at the top.

| file | what it does | env vars |
| --- | --- | --- |
| [`cosmos-payment.ts`](./examples/cosmos-payment.ts) | $0.07 USDC settle on Noble mainnet via the AgentOS freight seller — full end-to-end x402 payment, prints on-chain tx hash + mintscan link | `COSMOS_MNEMONIC` (12 or 24 BIP-39 words, with `MsgGrant` already on-chain to the facilitator grantee) |

Run any of them with `tsx`:

```bash
npm install @suverselabs/x402-client tsx
COSMOS_MNEMONIC="word1 word2 ... word24" npx tsx examples/cosmos-payment.ts
```

This recipe (Cosmos example, same wallet, same grantee, same AgentOS
endpoint) was used to settle a real $0.07 payment on 2026-05-30,
confirming the published npm package drives end-to-end on-chain
settlement — not just signature verification.

## Tests

The package ships **165 tests** (8 suites + 1 live-gated suite):

```bash
pnpm test                           # 163 unit tests, deterministic
SUVERSE_LIVE=1 pnpm test            # also runs 2 live probes against facilitator.suverse.io
```

The live probe sends a signed EVM envelope to `/facilitator/verify`
and asserts the facilitator → Coinbase CDP path doesn't reject at
the schema level. It's gated because it needs internet + Base
mainnet reachability; default unit runs stay offline + reproducible.

## License

Apache-2.0
