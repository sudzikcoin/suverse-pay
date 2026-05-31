# real-skale-base smoke

End-to-end real-settlement smoke for SKALE Base Sepolia
(`eip155:324705682`) via the PayAI facilitator (`payai-x402`).

Phase 5 Sub-task 7. This is the **acceptance gate** for declaring
SKALE Base supported in public materials: the test must produce a
real `transferWithAuthorization` tx whose hash is visible on
[`skale-base-sepolia-explorer.skalenodes.com`](https://skale-base-sepolia-explorer.skalenodes.com).
Until that's green, no README or external doc claims "SKALE Base
supported".

## What it does

A single Node script — no multi-step bash flow:

1. Loads `EVM_TESTNET_MNEMONIC` from `.env.evm-sepolia` at the repo
   root.
2. Signs an EIP-3009 `transferWithAuthorization` payload using
   `@suverse-pay/signer-evm` with the SKALE Base Sepolia USDC.e
   contract (`0x2e08028E3C4c2356572E096d8EF835cD5C6030bD`,
   on-chain-name `Bridged USDC (SKALE Bridge)`, version `2`).
3. POSTs `{paymentPayload, paymentRequirements}` to
   `https://facilitator.payai.network/verify`, expects
   `isValid: true`.
4. POSTs the same body to `/settle`, expects `success: true` plus
   a 32-byte hex `transaction` / `txHash`.
5. Prints the explorer URL.

The suverse-pay gateway is intentionally **not** in the loop. That
isolates the question this smoke answers — "does PayAI accept our
signature for SKALE Base?" — from any gateway plumbing. Once the
direct-PayAI path is green, the gateway integration is just the
already-landed `eip155:324705682:exact → ["payai"]` row in
`services/facilitator/src/routing-config.ts`.

## Funding the test wallet

The from-address (`EVM_TESTNET_ADDRESS` in `.env.evm-sepolia`) needs
**USDC.e on SKALE Base Sepolia** — and only that. The chain is
gasless for buyers (PayAI pre-pays CREDIT as the relayer), so no
native gas required.

1. **Acquire test USDC on Base Sepolia** (the source-side L2): use
   the Coinbase CDP faucet or any Base Sepolia USDC faucet to fund
   the wallet with at least a few `0.001`-atomic units of
   `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.
2. **Bridge it into SKALE Base Sepolia**: open
   [`base-sepolia.skalenodes.com/chains/base`](https://base-sepolia.skalenodes.com/chains/base),
   connect the test wallet, bridge a small amount of USDC. Allow
   1–3 minutes for the SKALE IMA bridge to confirm.
3. **Sanity-check on-chain**: read the USDC.e balance via
   `eth_call balanceOf(0xYourAddress)` against
   `https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha`.

Each smoke run consumes the `--amount` value (default `1000` atomic
= 0.001 USDC.e). Keep at least 3× that buffer for retries.

## Optional: PayAI API key

PayAI's `/verify` + `/settle` accept anonymous calls today. If
you've registered a PayAI testnet API key, export it for stronger
rate-limit + observability:

    export PAYAI_API_KEY_ID=...
    export PAYAI_API_KEY_SECRET=...

## Running

```sh
# Make sure the signer's dist/ is up to date.
pnpm --filter @suverse-pay/signer-evm build

# Run the smoke against a recipient address you control.
pnpm tsx scripts/smoke/real-skale-base/smoke.mts \
  --pay-to 0xYourReceivingAddress
```

The whole run is one HTTP round-trip to `/verify` and one to
`/settle` — typically completes in a few seconds.

## Exit codes

| code | meaning |
|------|---------|
| 0    | settled with a 32-byte tx hash; explorer URL printed |
| 1    | infrastructure / setup error (missing env, RPC down, signer threw) |
| 2    | PayAI `/verify` returned `isValid: false` — usually an EIP-712 domain mismatch. See the body it returned. **Do not edit `domains.ts` without re-running `eth_call name()` / `version()`** — the strings on this chain are non-obvious. |
| 3    | PayAI `/settle` returned `success: false` |
| 4    | settle returned success but no/invalid txHash |

## After it passes

Open the printed explorer URL and visually confirm the tx exists.
That's the green light to flip the public README + CHANGELOG
claims from "in development" to "supported", and to graduate the
mainnet routing entry from "registered, untested" to "live" with
a tracking memory.
