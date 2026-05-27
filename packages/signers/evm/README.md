# @suverse-pay/signer-evm

TypeScript signer for the x402 `exact` scheme on EVM networks via
EIP-3009 `transferWithAuthorization`. Sibling of
`@suverse-pay/signer-cosmos`.

## What this does

```ts
import { signPaymentPayload } from "@suverse-pay/signer-evm";

const signed = await signPaymentPayload({
  secret: "twelve or twenty-four BIP-39 words ..." /* OR "0xPRIVATE_KEY_64_HEX" */,
  network: "eip155:8453",        // CAIP-2 for Base
  requirements,                  // PaymentRequirements from the 402 response
  amount: "1000000",             // 1 USDC (6 decimals)
  validitySeconds: 60,           // must be <= requirements.maxTimeoutSeconds
});

// signed.paymentPayload + signed.paymentRequirements is the body for
// POST /verify or POST /settle on a CDP-compatible facilitator.
```

## Phase 2 scope

- **Scheme**: `exact` (EIP-3009 `transferWithAuthorization`)
- **Networks**: Base (`eip155:8453`), Polygon (`eip155:137`), Arbitrum (`eip155:42161`)
- **Tokens**: USDC (all three chains) + EURC (Base only — EURC is not deployed on Polygon/Arbitrum at the time of Phase 2)

## Deferred to v0.3+

- **Permit2 fallback path** for ERC-20s that do NOT implement EIP-3009.
  EIP-3009 covers USDC and EURC; tokens like USDT, DAI, etc. require
  Permit2. Not in Phase 2.
- **Other networks**: Ethereum mainnet (`eip155:1`), Optimism, World
  chain. Each needs its own (verifyingContract, name, version) entry.
- **Real Coinbase CDP settle** — requires a CDP API key we don't have
  yet. The round-trip test below covers EIP-712 math but not on-chain
  validity of the (name, version, contract) triple.

## Why it works

EIP-3009 typed-data signing is standardized — viem handles the EIP-712
hash construction. The interesting parts are:

1. **Domain table** (`domains.ts`): per (chainId, ERC-20 contract)
   tuple, a locally-trusted `{name, version, chainId, verifyingContract}`.
   The signer ignores whatever `requirements.extra.name` /
   `requirements.extra.version` the resource server claims — they must
   match our trusted entry, or the signer refuses. Defense in depth: a
   malicious resource server cannot trick us into signing for the
   wrong domain.
2. **Authorization fields** (`eip3009.ts`): `value`, `validAfter`,
   `validBefore` are `uint256` so viem wants `bigint` on the JS side
   even though the wire format encodes them as decimal strings.
   `nonce` is `bytes32` so it stays as `0x`-prefixed hex.
3. **Signature**: viem's `signTypedData` returns a 65-byte
   `0x`-prefixed hex string (132 hex chars + `"0x"`). That's `r ||
   s || v` — the canonical EVM signature format expected by EIP-3009
   verifiers.

The `verifyingContract` addresses come from Circle's published
deployments for native USDC/EURC. They are best-known values; the
round-trip test only validates EIP-712 mathematical correctness, not
that these addresses actually point at the real contracts. **A wrong
verifyingContract would surface only at on-chain settle time.** When
CDP becomes available, run the smoke against testnet and adjust the
table if any pair fails.

## Tests

```bash
pnpm --filter @suverse-pay/signer-evm test
```

15 tests, including the **round-trip gate** (`recoverTypedDataAddress`
must return the signing address for every trusted (chain, token) pair
in `domains.ts`). All 4 trusted pairs pass. New entries added to
`domains.ts` automatically pick up a round-trip test, so adding a
network is just: append to the domain table → tests pass or report a
typo in the address/version.

## Security

The `secret` is held only for the duration of `signPaymentPayload`.
Inside the function it materializes briefly as a viem `Account` object
which holds the private key in memory; the function returns the
signature only. Callers MUST not log the secret. The `Session` class
in `apps/mcp` enforces this via Buffer zeroing across the broader MCP
session lifetime.
