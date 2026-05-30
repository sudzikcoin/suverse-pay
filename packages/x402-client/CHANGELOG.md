# Changelog

All notable changes to `@suverselabs/x402-client` are documented here.
This project adheres to [Semantic Versioning](https://semver.org/) —
note pre-1.0 minor releases may change wire format or public API.

## [0.1.0] — 2026-05-30 — Initial release

First publishable buyer-side SDK for the x402 protocol. Pays any
seller across **23 networks** (18 EVM mainnets + 3 testnets + Solana
mainnet + Solana devnet + Cosmos Noble mainnet + Cosmos Noble testnet
+ TRON mainnet + TRON Nile) through a single `client.fetch(url)` API.

### Features by VM family

#### EVM (18 mainnets, 3 testnets) — `scheme: "exact"`

- One private key (or viem `LocalAccount`) signs for every chain.
- EIP-3009 `TransferWithAuthorization` typed data.
- Per-chain `name` / `version` / `verifyingContract` strings vendored
  from on-chain `eth_call` probes; not guessed.
- Defence-in-depth: signer rejects when seller's
  `extra.{name,version}` disagrees with the trusted local USDC
  domain (anti-spoof).
- Excluded with `chain_not_eip3009`: BNB Chain (Binance-Peg USDC is
  EIP-2612), Tempo (USDC `version()` reverts).
- Supported: Ethereum (1), Optimism (10), XDC (50), Polygon (137),
  Monad (143), Sonic (146), World Chain (480), Sei (1329),
  Abstract (2741), IoTeX (4689), Base (8453), Arbitrum (42161),
  Celo (42220), Avalanche (43114), Ink (57073), Linea (59144) —
  16 mainnets, plus 3 Sepolia/Fuji testnets.

#### Solana (mainnet + devnet) — `scheme: "exact"`

- Partial-signs a `VersionedTransaction`:
  `ComputeBudget.setLimit` + `setPrice` + SPL `transferChecked` + Memo.
- Buyer signs as the SPL authority; facilitator co-signs as
  `feePayer` — buyer never spends SOL.
- Wallet shapes: base58 64-byte secret key string, 64-byte Uint8Array
  secret key, OR 32-byte Uint8Array seed. BIP-39 mnemonic NOT
  supported in v0.1.0 (would bloat install size).
- Tokens recognised: USDC mainnet (`EPjFW...Dt1v`), USDT mainnet
  (`Es9vMFrz...NYB`), USDC devnet (`4zMMC9srt...cDU`).
- Spec checks: fee-payer ≠ source authority; fee-payer ∉ {sourceATA,
  destinationATA}; memo ≤ 256 bytes; CU price ≤ 5_000_000.

#### Cosmos Noble (mainnet + testnet) — `scheme: "exact_cosmos_authz"`

- ADR-036 signing chain: recursive canonical JSON (sorted keys,
  HTML-escaped `&` `<` `>`), wrap in outer ADR-036 doc, canonical
  again, SHA-256, secp256k1 sign, take r||s (64-byte, NOT DER).
- BIP-39 mnemonic at Cosmos HD path `m/44'/118'/0'/0/0` OR 32-byte
  raw private key Uint8Array.
- Wire-format invariants verified against the production
  `pay-suverse-agentos-cosmos.mjs` script that settled the first
  Noble mainnet payments (tx `5A0D8E2A…F445`, `F11FE419…3132`).
- Pre-condition (NOT enforceable client-side): payer must run
  `MsgGrant{SendAuthorization}` to the facilitator grantee on-chain
  BEFORE any payment can verify.

#### TRON (mainnet + Nile) — `scheme: "exact_gasfree"` only, ⚠️ experimental

- TIP-712 (EIP-712-equivalent on TRON) `PermitTransfer`, relayed by
  gasfree.io. Buyer never holds TRX for gas.
- $1.50 USDT minimum hard-coded (gasfree.io rejects below this).
- Default `maxFee` capped at `min(defaultMaxFee, value/2)` —
  prevents seller from setting `value` low + `maxFee` high to drain
  buyer.
- gasfree.io contract address (`verifyingContract`) is a placeholder
  by default; signer refuses to sign until
  `signerOptions.tron.gasfreeDomain.{mainnet,nile}` is configured.
- `exact` and `exact_permit` schemes throw
  `scheme_not_implemented_v0_1_0` — Tether USDT on TRON has no
  EIP-3009 or EIP-2612 pathway today.

### `SuverseClient` API

- `.fetch<T>(url, init?)` — drop-in `fetch`. Handles 402 challenge
  parsing + signing + retry; returns `{ data, response, payment }`.
- `.pay(challenge, prefs?)` / `.signFor(challenge, prefs?)` —
  produces the base64 `PAYMENT-SIGNATURE` header value for an
  already-parsed challenge.
- `.signRequirement(requirement, options?)` — signs one specific
  `AcceptedRequirement`. `options.resource` is required on Cosmos
  networks (part of the signed preimage).
- `wallets: { evm, solana, cosmos, tron }` — any subset; client only
  signs on chains it has a matching wallet for.
- `preferences: { preferredNetwork, avoidNetworks, maxGasUsd }` —
  routing overrides.
- `signerOptions.{ solana, cosmos, tron }` — per-VM tunables
  (Solana RPC endpoint, Cosmos validity window, TRON gasfree
  domain).

### Network selection (in `routing.ts`)

1. Filter seller's `accepts` against wallet availability,
   `avoidNetworks`, and per-network feasibility (EIP-3009 capability
   for EVM, `exact_gasfree` for TRON, `$1.50` minimum on TRON, etc.).
2. If `preferredNetwork` is in the surviving set, take it.
3. Otherwise rank by cost class and take the cheapest:
   Cosmos Noble > Solana > TRON > EVM L2 > EVM L1 > testnets.

### Test coverage

165 tests across 9 suites (one gated on `SUVERSE_LIVE=1`):

- `chains.test.ts` (11) — registry shape, lookup helpers, USDC
  format invariants.
- `challenge.test.ts` (9) — v2 + v1 parser, header decode, error
  paths.
- `routing.test.ts` (11) — cost ranking, preferences, TRON scheme
  filter, gasfree minimum.
- `evm-signer.test.ts` (36) — construction, all 19 eip3009-capable
  chains sign cleanly, EIP-712 round-trip via
  `recoverTypedDataAddress`, all rejection paths.
- `solana-signer.test.ts` (23) — wallet shapes, partial-sign byte
  layout (fee-payer slot zeroed), instruction count, determinism,
  spec rejections.
- `cosmos-signer.test.ts` (21) — canonical JSON sort + HTML escape
  byte-exact, ADR-036 outer doc, deterministic signing,
  `Secp256k1.verifySignature` round-trip.
- `tron-signer.test.ts` (24) — address conversion (incl USDT
  contract → 0xa614f8…d13c well-known mapping), `$1.50` minimum at
  boundary, maxFee capping math, scheme rejections, TIP-712 recovery.
- `client.test.ts` (28) — end-to-end .fetch() per VM with mocked
  fetchImpl, preferences, error paths, .pay() ⇔ .signFor() alias.
- `live-facilitator.test.ts` (2, gated) — real wire-format probe
  against `https://facilitator.suverse.io`; confirms our EVM
  envelope passes through to Coinbase CDP without parse-level
  rejection.

### Runtime dependencies

- `viem ^2.51.2` — EVM + TRON typed-data signing
- `@solana/web3.js ^1.95.4` + `@solana/spl-token ^0.4.9` — SVM
- `@cosmjs/crypto ^0.32.4` + `@cosmjs/encoding ^0.32.4` +
  `@cosmjs/amino ^0.32.4` — Cosmos (no `proto-signing` or
  `stargate` weight)
- `bs58 ^6.0.0` + `bs58check ^4.0.0` — base58/base58check codecs

ESM only. Node 20+.

### Notes

- Default facilitator URL: `https://facilitator.suverse.io`.
  Override per `defaultFacilitator` if you point at a different
  x402 v2 facilitator. The client doesn't talk to the facilitator
  directly — the seller's 402 response says which facilitator was
  used.
- v0.1.0 is ESM-only. CJS dual output may come in v0.2 if there's
  demand.
- TRON wire format is **experimental** in v0.1.0 — see the
  README disclaimer. Cosmos, Solana, and EVM all have settled
  real-money mainnet payments through this code path.
