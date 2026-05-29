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

## Phase 4 Block 2 Sub-task 6 — Permit2 path (USDT)

EIP-3009 covers USDC/EURC; **USDT does not implement EIP-3009**. Sub-task
6 adds a Permit2 signing path that works for any ERC-20, settled via
the canonical x402ExactPermit2Proxy.

```ts
import { signPermit2UsdtAuthorization } from "@suverse-pay/signer-evm";

const signed = await signPermit2UsdtAuthorization({
  secret: "twelve or twenty-four BIP-39 words ...",
  network: "eip155:1",              // CAIP-2 for Ethereum mainnet
  amount: "1000000",                // 1 USDT (6 decimals)
  payTo: "0xRecipient...",          // becomes witness.to — binds funds
  validitySeconds: 60,
});

// signed.payload — { signature, permit2Authorization } — goes verbatim
// into paymentPayload.payload alongside scheme="exact" and
// extra.assetTransferMethod="permit2" per x402 spec.
```

Or sign against any registered ERC-20 (USDT, future tokens):

```ts
import { signPermit2Authorization } from "@suverse-pay/signer-evm";

const signed = await signPermit2Authorization({
  secret, network: "eip155:42161",
  token: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",  // Arbitrum USD₮0
  amount: "5000000",
  payTo,
});
```

### How the dispatch decision is made

Today both paths are explicit (caller chooses which function). The
spec's default behaviour — prefer EIP-3009 when the token supports it
and fall back to Permit2 otherwise — lives in the orchestrator/adapter
layer, not the signer. The `Permit2TokenEntry.hasEip3009` /
`hasEip2612Permit` flags expose what each token supports so callers
can branch.

### What's wired and what isn't

- **Signing**: ✓ Full EIP-712 PermitWitnessTransferFrom signature
  production, viem-backed, round-trip verified across 9 registered
  USDT chains.
- **Token registry**: ✓ USDT on Ethereum, Optimism, Polygon (USDT0),
  Base, Arbitrum, Celo, Avalanche, Sei, Linea. All on-chain-verified
  via `name()/symbol()/decimals()` 2026-05-29.
- **Permit2 contract presence**: ✓ Confirmed deployed on 16 EVM
  mainnets via `eth_getCode`.
- **x402ExactPermit2Proxy presence**: ✓ Confirmed on 11 of 16 chains
  (Sonic, Abstract, IoTeX, Ink, Linea missing — proxy needs upstream
  CREATE2 deploy before x402 settle will work there; signing still
  succeeds, settlement will revert).
- **Adapter / routing wiring**: ✗ **Deferred.** Neither Coinbase CDP
  nor Thirdweb advertises `assetTransferMethod: "permit2"` in
  `/supported` as of 2026-05-29 — adapter wiring would produce dead
  code. Sub-task 6 ships the signing primitives so the moment a
  facilitator advertises Permit2 support, the gateway can adopt it
  with a config change rather than a fork.
- **Approval flow**: ✗ **Out of signer scope.** Permit2 requires a
  one-time `ERC20.approve(Permit2, MaxUint256)` from each user before
  their first Permit2 settlement. The x402 spec defines three paths
  for this (direct approval, gas-sponsored approval, EIP-2612-permit-
  to-Permit2). All three live above the signer — none affect the
  PermitWitnessTransferFrom signature itself.

## Deferred to Phase 5

- **Real on-chain Permit2 settle** — requires a CDP/Thirdweb API key
  that advertises Permit2 + a wallet with pre-approved Permit2 for
  the target token. Round-trip tests below cover EIP-712 math; they
  do NOT prove on-chain `permitWitnessTransferFrom` accepts the
  signature.
- **EIP-2612 Permit signer for the gas-sponsored approval path** —
  this is a separate EIP-712 domain (token's own domain, not
  Permit2's) and a separate sub-task. The signer-evm currently
  produces only EIP-3009 (USDC) and Permit2 PermitWitnessTransferFrom
  (USDT etc.).
- **Real Coinbase CDP settle on EIP-3009** path — the same gap as
  Phase 2 but now also gated on CDP advertising Permit2 in
  /supported for the USDT path.

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
