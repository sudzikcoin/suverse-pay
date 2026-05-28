# mcp-solana smoke suite

REAL Solana devnet end-to-end smoke through the MCP server, settled by
PayAI (no Coinbase CDP API key needed). Added in Phase 3 Sub-task 7.

## What it covers

| Step | What it does |
|---|---|
| 00-setup | Verifies suverse-pay :3000, PayAI reachability, Solana devnet RPC, devnet wallet balance (USDC-Dev + SOL-Dev for ATA rent). Spawns the mock x402 server (`mock-x402-devnet/index.mjs`) and the MCP server. STOPS with explicit funding instructions if the wallet is dry. |
| 01-init-session | `init_session` with the devnet mnemonic; asserts the derived base58 address matches `.env.solana-devnet`. |
| 02-discover | Informational `discover_endpoints` call; Bazaar typically has no devnet entries — this step doesn't gate on count, just proves the tool runs. |
| 03-pay-and-call-devnet | The headline test. `pay_and_call` against the mock x402 server → 402 → `recentBlockhash` fetched from devnet RPC → signer-solana mints SPL `transferChecked` (self-transfer, 100 atomic units = 0.0001 USDC-Dev) → mock forwards to PayAI `/settle` → PayAI co-signs and submits → real Solana devnet `txSignature` returned. |
| 04-pay-and-call-idempotent | Replay 03 → MCP's in-process idempotency cache short-circuits; same `paymentId` + `txSignature`, no second on-chain transaction. |
| 99-teardown | Stops the mock + MCP. Leaves suverse-pay :3000 and cosmos-pay :8402 running. |

## What's real

Everything except the resource-server-side HTTP wrapper:

- ✅ **Real** signing (signer-solana, ed25519 over the SPL transferChecked
  message).
- ✅ **Real** Solana devnet `recentBlockhash` fetched at sign time from
  `https://api.devnet.solana.com`.
- ✅ **Real** PayAI facilitator co-signing + submission.
- ✅ **Real** on-chain Solana devnet transaction with a public
  txSignature (viewable on `explorer.solana.com/...?cluster=devnet`).
- 🟡 **Mocked** the resource server — `mock-x402-devnet/index.mjs` is a
  thin Fastify app that emits 402 with the right `PaymentRequirements`
  and forwards PAYMENT-SIGNATURE to PayAI's `/settle`. It doesn't
  exercise resource-server middleware behavior; it just stands in for
  one.

## First-time setup — funding the devnet wallet

The suite uses a fresh devnet wallet generated in Phase 3 Sub-task 7
and stored in `.env.solana-devnet` (gitignored). The address is
public — only the mnemonic is sensitive.

```
address: C37c1kFEBsH4Rf4U6eEgzWgCLJ5Bicc6MiQV1eEuw1sD
mnemonic: stored in /home/govhub/suverse-pay/.env.solana-devnet (chmod 600)
```

To fund it before the first run:

1. **USDC-Dev** — visit [`https://faucet.circle.com`](https://faucet.circle.com),
   select `Solana → Devnet`, paste the address, request at least
   1 USDC-Dev (which becomes 1,000,000 atomic units with 6 decimals).
2. **SOL-Dev** — visit [`https://faucet.solana.com`](https://faucet.solana.com),
   paste the same address, request a small drip (0.5 SOL is plenty).
   The SPL transferChecked path needs SOL to pay for any newly-created
   associated token account; in this suite we self-transfer so the
   ATA already exists, but the wallet still pays the per-tx fee
   sponsored by PayAI's facilitator. We require ≥ 5,000,000 lamports
   (0.005 SOL) as a safety floor.

Verify the funding manually:

```bash
curl -sS https://api.devnet.solana.com -X POST \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getTokenAccountsByOwner",
       "params":["C37c1kFEBsH4Rf4U6eEgzWgCLJ5Bicc6MiQV1eEuw1sD",
                 {"mint":"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"},
                 {"encoding":"jsonParsed"}]}' \
  | jq '.result.value[0].account.data.parsed.info.tokenAmount.uiAmountString'
```

## Running

```bash
# Make sure suverse-pay is up.
curl -sf http://localhost:3000/health

bash scripts/smoke/mcp-solana/run-all.sh
```

If the wallet is dry, 00-setup STOPs with the funding instructions
above and exits 1. After funding, re-run.

## Cost

Each pay_and_call settles 100 atomic units = 0.0001 USDC-Dev. The
self-transfer architecture means the payer ATA receives back what it
sent, so the only "cost" is PayAI's facilitator gas fee, which it
absorbs on devnet. The wallet doesn't drain.

Idempotency means re-running the suite in the same hour bucket
returns the same txSignature without minting a new one — pleasant for
development but means you only see a new on-chain tx every ~hour
unless you bump the URL or body to bust the cache.

## Architecture

```
agent → MCP (apps/mcp)
   │      │
   │      │  pay_and_call(url=mock/premium)
   │      ▼
   │   mock-x402-devnet  ──402(SolanaPR)──►  MCP
   │      ▲                                   │
   │      │                                   │  fetch blockhash
   │      │                                   ▼
   │      │                            api.devnet.solana.com
   │      │                                   │
   │      │                                   ▼
   │      │                            signer-solana
   │      │                              (SPL transferChecked)
   │      │                                   │
   │      │  PAYMENT-SIGNATURE  ◄─────────────┘
   │      ▼
   │   POST /settle (paymentPayload + paymentRequirements)
   │      │
   │      ▼
   │   facilitator.payai.network
   │      │
   │      ▼  co-sign + submit
   │   Solana devnet
   │      │
   │      ▼
   │   txSignature returned
   │      ▲
   │      │  PAYMENT-RESPONSE (success, transaction=<sig>)
   ▼      │
agent ◄───┘  response body + txSignature
```

`suverse-pay :3000` is in the picture only for `list_providers` /
`discover_endpoints` queries — the agent-side payment flow is
deliberately direct (MCP signs locally, posts PAYMENT-SIGNATURE to the
resource server, resource server forwards to its facilitator of
choice).
