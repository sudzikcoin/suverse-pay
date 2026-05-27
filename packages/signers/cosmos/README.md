# @suverse-pay/signer-cosmos

TypeScript signer for the `exact_cosmos_authz` x402 scheme. Produces
ADR-036 PaymentPayload JSON byte-compatible with the Go reference at
`x402-cosmos/tools/fixture`.

## What this does

```ts
import { signPaymentPayload } from "@suverse-pay/signer-cosmos";

const signed = await signPaymentPayload({
  mnemonic: "twelve or twenty-four BIP-39 words ...",
  network: "cosmos:grand-1",
  requirements,           // PaymentRequirements from a 402 response
  amount: "10000",        // atomic units (uusdc, 6 decimals)
  validitySeconds: 50,    // window size, <= requirements.maxTimeoutSeconds
});

// signed.paymentPayload + signed.paymentRequirements is the body for
// POST /verify or POST /settle on a cosmos-pay-compatible facilitator.
```

## Why it works

The ADR-036 sign-bytes construction is finicky — one wrong byte and
the verifier rejects. This signer matches the Go reference exactly:

1. **HD derivation**: `m/44'/118'/0'/0/0` via @cosmjs/crypto's Slip10.
2. **Address**: bech32-encode `ripemd160(sha256(compressed_pubkey))[:20]`
   with the network's prefix (currently always `noble` for grand-1).
3. **Canonical Authorization JSON**: keys sorted lexicographically at
   every level, no whitespace, Go-style HTML escaping of `&`/`<`/`>`.
   See `adr036.ts` `sortedJsonStringify` + `escapeJsonHtmlChars`.
4. **Outer doc**: ADR-036 StdSignDoc with `account_number: "0"`,
   `chain_id: ""`, `sequence: "0"`, `fee: { amount: [], gas: "0" }`,
   `msgs[0] = { type: "sign/MsgSignData", value: { data: base64(canonical_auth), signer: payer } }`.
   Serialized through the same canonicalizer.
5. **Signature**: SHA-256 the canonical-doc UTF-8 bytes, then
   `Secp256k1.createSignature(digest, privkey)`. Strip the recovery byte
   (cosmos verifiers want 64-byte `r||s`, not the 65-byte extended form).

`Secp256k1.createSignature` produces RFC 6979 deterministic, low-S
signatures — same key + same digest → same signature byte-for-byte
across Go and TS.

## Phase 2 network support

Only `cosmos:grand-1` (Noble testnet). Mainnet (`cosmos:noble-1`) is
intentionally NOT in the supported list — we have no funded mainnet
facilitator. Re-add when a mainnet deployment exists; the bech32 prefix
stays `noble`.

## Tests

`pnpm --filter @suverse-pay/signer-cosmos test` — 11 unit tests cover
derivation, sig/pubkey length, validity window, error paths.

The critical compatibility gate (`cosmos-pay /verify` returns
`isValid: true` for a TS-signed payload) was verified against a live
facilitator during Phase 2 Sub-task 2 development. It is not committed
as an automated test because it requires a real testnet mnemonic with
an on-chain grant.

## Security

The mnemonic is held only for the duration of the `signPaymentPayload`
call. Inside the function it expands to a 64-byte BIP-39 seed and a
32-byte raw privkey held in `Uint8Array`s. Neither is logged, returned,
or persisted. Callers MUST clear their copy of the mnemonic when done
(the `Session` class in `apps/mcp` handles this via Buffer zeroing).
