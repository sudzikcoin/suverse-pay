# @suverse-pay/signer-solana

TypeScript signer for the x402 `exact` scheme on Solana (SVM). Sibling
of `@suverse-pay/signer-cosmos` and `@suverse-pay/signer-evm`.

## What this does

```ts
import { signPaymentPayload, SOLANA_MAINNET } from "@suverse-pay/signer-solana";

const signed = await signPaymentPayload({
  secret: "twelve or twenty-four BIP-39 words ..." /* OR a base58 secret key */,
  network: SOLANA_MAINNET,        // "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
  requirements,                   // PaymentRequirements from the 402 response
  amount: "1000",                 // atomic units; must equal requirements.maxAmountRequired
  recentBlockhash: "<base58 of a recent block hash>",
});

// signed.paymentPayload + signed.paymentRequirements is the body for
// POST /verify or POST /settle on an x402 facilitator.
```

`recentBlockhash` is a required input — this package is intentionally
network-free so it can be tested deterministically and used offline.
Production callers fetch it via `@solana/web3.js`:

```ts
import { Connection } from "@solana/web3.js";
const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com");
const { blockhash } = await conn.getLatestBlockhash();
```

## Phase 3 scope

- **Scheme**: `exact` (SPL `transferChecked` with facilitator as fee payer)
- **Network**: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (mainnet)
- **Tokens**: USDC (`EPjFW…Dt1v`), EURC (`HzwqbKZw…DKtr`)
- **HD path**: `m/44'/501'/0'/0'` — matches Phantom, Solflare,
  Backpack, and the `solana-keygen` CLI

## Deferred to v0.4+

- **Token-2022 program** for newer SPL tokens. Current x402
  implementations and USDC native both still use the original SPL
  Token program (`Tokenkeg…vQ5DA`), so Token-2022 is not blocking.
- **Solana devnet** as a separate CAIP-2 network. Phase 3 is
  mainnet-only because PayAI / Coinbase CDP facilitators cover
  mainnet first.
- **Real on-chain smoke** — deferred until either the Coinbase CDP
  Solana settle path is available (needs CDP API key, Sub-task 4) or
  PayAI's adapter lands (Sub-task 3). The current correctness gate
  is offline signature verification (see "Tests" below).

## How it works

The x402 SVM exact scheme is described in
`coinbase/x402/specs/schemes/exact/scheme_exact_svm.md`. In short:

1. The CLIENT (this signer) constructs a Solana versioned transaction
   containing exactly these instructions, in this order:
   - `ComputeBudget::SetComputeUnitLimit` (200_000)
   - `ComputeBudget::SetComputeUnitPrice` (1000 microlamports — spec
     caps it at ≤ 5 lamports / CU; we stay well below)
   - SPL Token `transferChecked` (source ATA → destination ATA, with
     decimals safety)
   - SPL Memo (either `requirements.extra.memo` or a fresh
     16-byte hex random nonce — required for on-chain uniqueness)
2. The transaction's `feePayer` is set to
   `requirements.extra.feePayer` — the facilitator's pubkey.
3. The CLIENT partially-signs (one signature; feePayer slot stays
   zero). The transaction is base64-encoded.
4. The FACILITATOR receives the payload via `/verify` / `/settle`,
   inspects it (per the spec's "Facilitator Verification Rules
   MUST"), signs the feePayer slot, and submits to Solana.

The signer ENFORCES the fee-payer safety checks at sign time as well
— refusing to produce a payload where the fee payer is the payer's
own pubkey, appears in any transferChecked account slot, or equals
the source/destination ATA. Defense in depth: even if a malicious
resource server crafts a bad PaymentRequirements, we won't sign
something that could drain the facilitator.

## Tests

```bash
pnpm --filter @suverse-pay/signer-solana test
```

23 tests. The critical gate:

- **Round-trip signature verification** — `nacl.sign.detached.verify`
  of the signed transaction's message bytes against the derived
  payer pubkey returns `true`. Same primitive but with a flipped bit
  in the message returns `false`. This proves the EIP-3009-equivalent
  signing math is internally consistent.
- Address derivation matches the canonical Phantom / Solflare result
  for the canonical BIP-39 test mnemonic at `m/44'/501'/0'/0'`. The
  expected address is pinned so any library drift surfaces.
- Instruction layout is exactly the four required by the SVM spec.
- Fee-payer safety checks fire on the three forbidden configurations
  (feePayer = payer, feePayer in tx account list, feePayer = ATA).
- Memo defaults to a 32-char hex random nonce when seller doesn't
  pin one.

The round-trip test does NOT prove the transaction would land
on-chain — only a real facilitator can do that. When CDP or PayAI
become live for us, real settle smoke gets wired in. Until then,
this offline gate plus the facilitator's own verification rules are
the contract.

## Security

The mnemonic / secret key is held only inside `deriveKeypair` for the
duration of `signPaymentPayload`. It's NEVER logged or returned in
the result. The MCP server's `Session` class enforces the same
discipline at a higher level via Buffer-zeroing.

The signer enforces the SVM spec's fee-payer safety constraints
client-side, so a buggy or malicious resource server cannot trick us
into producing a payload that drains the facilitator's wallet.
