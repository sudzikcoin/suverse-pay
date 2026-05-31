# Real MPP Moderato smoke

End-to-end test for the MPP Phase 2 v1 surface against the LIVE Tempo
Moderato testnet (chain id 42431). This is the test T10 must turn
green before we can claim "MPP integrated".

## What it does

1. Funds a test wallet via the Tempo native `tempo_fundAddress` RPC
   method (no manual faucet button click).
2. Calls `POST /mpp/charge` initially — expects 402 +
   `WWW-Authenticate: Payment ...`.
3. Signs an ERC-20 `transfer(recipient, amount)` call against the
   pathUSD contract on Moderato.
4. Broadcasts via `eth_sendRawTransaction` to the Tempo Moderato RPC.
5. Polls `eth_getTransactionReceipt` until confirmation.
6. Re-calls `POST /mpp/charge` with the `Payment-Authorization`
   header carrying an MPP credential `{type: "hash", hash: <tx>}`.
7. Expects 200 + `Payment-Response` header + the persisted payments
   row carries `protocol="mpp"`.
8. Prints the explorer URL — operator verifies the tx is real.

## Prerequisites

- `pnpm build` has run (the script imports the compiled
  `packages/adapters/mpp/dist`).
- A running suverse-pay API on `BASE_URL` (default
  `http://127.0.0.1:3000`) with `STRIPE_MPP_ENABLED=true` and access
  to `https://rpc.moderato.tempo.xyz` (no auth required).
- An EVM test wallet whose secp256k1 private key sits in
  `MPP_TEST_PRIVATE_KEY`. The script funds it via
  `tempo_fundAddress` but works the same if you fund manually via
  `https://explore.testnet.tempo.xyz` faucet.

## Required env vars

| Var | Default | Notes |
|---|---|---|
| `MPP_TEMPO_MODERATO_INTEGRATION` | `0` | Set to `1` to actually run. Without it the script no-ops. |
| `ADMIN_API_KEY` | — | Gateway tenant Bearer key (same one the gateway is booted with). |
| `MPP_TEST_PRIVATE_KEY` | — | 0x-prefixed 32-byte hex. The buyer-side wallet. |
| `BASE_URL` | `http://127.0.0.1:3000` | Suverse-pay API base. |
| `MPP_TEMPO_MODERATO_RPC_URL` | `https://rpc.moderato.tempo.xyz` | Override only for private RPC mirrors. |
| `MPP_TEST_RECIPIENT` | `0x0000…bEEf` | Recipient address; the merchant. |
| `MPP_TEST_AMOUNT_ATOMIC` | `1000` | pathUSD atomic units (6 decimals → 0.001 pathUSD). |

## Run

```bash
# Start the gateway with MPP enabled.
pnpm dev   # in another shell, or however your local API runs

# Then, in this shell:
export MPP_TEMPO_MODERATO_INTEGRATION=1
export ADMIN_API_KEY=<your gateway admin key>
export MPP_TEST_PRIVATE_KEY=0x<32-byte hex>
pnpm tsx scripts/smoke/real-mpp-moderato/real-mpp-charge.mts
```

A green run prints `MPP Phase 2 v1 e2e GREEN` + the explorer URL.
A red run exits non-zero with a clear `✗` line; the explorer URL of
any tx that was broadcast is still printed so the operator can
inspect it.

## Known risks (Phase 2)

- **Tempo tx envelope.** Tempo uses a custom transaction envelope
  (`0x76`/`0x78`) for full-feature txs. This smoke uses the standard
  EIP-155 `legacy` type via viem, on the bet that the Moderato RPC
  accepts plain legacy transfers for ERC-20 contracts. If
  `eth_sendRawTransaction` rejects, we'll need either viem's
  `experimental_tempo` extension or to switch to a different signing
  path. The first red run on T10 surfaces this clearly.
- **No gas token on Tempo.** Fees are paid in any whitelisted
  stablecoin. `gasPrice` from `eth_gasPrice` may be zero or in
  pathUSD-denominated units; the script trusts the RPC's quote.
- **pathUSD funding.** `tempo_fundAddress` may or may not include
  pathUSD; if it doesn't, the script's `transfer` reverts at
  `insufficient balance`. Fund manually via the docs.tempo.xyz
  faucet API if needed:
  ```
  curl -X POST https://docs.tempo.xyz/api/faucet \
    -H "Content-Type: application/json" \
    -d '{"address": "<YOUR_ADDRESS>"}'
  ```

## After it goes green

Capture:

- The commit hash that produced the green run.
- The on-chain tx hash + the `https://explore.testnet.tempo.xyz/tx/<hash>` URL.
- The `paymentId` from the 200 response.

These go into Phase 2 T10's CHANGELOG entry as proof of e2e.
