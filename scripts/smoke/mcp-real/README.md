# mcp-real smoke suite

End-to-end MCP smoke against **real cosmos-pay** and **real
suverse-pay** infrastructure, with the x402-cosmos `examples/server`
demo as the paid endpoint. A successful run broadcasts a real
`MsgExec(MsgSend)` on Noble testnet `grand-1`.

## What this proves

- The full Phase 2 path works end-to-end on a live chain:
  `agent → MCP → 402 → ADR-036 sign → /settle → on-chain → retry → response`.
- The MCP-derived Idempotency-Key (payerAddress + hourBucket, **not**
  sessionId) is stable across replays — a second `pay_and_call` with
  the same `(url, body)` within the hour returns the same paymentId
  and DOES NOT broadcast a second transaction.
- `get_payment_status` reports `attempts: 1` after the replay, which
  is the strongest invariant we can demonstrate on-chain.

## What this does NOT cover

- **EVM real-network smoke**. Deferred to v0.3+: requires a Coinbase
  CDP API key for /settle on Base Sepolia. EVM signing is verified
  offline via `recoverTypedDataAddress` round-trip (see
  `packages/signers/evm`).

## Pre-conditions

1. **cosmos-pay running** on `localhost:8402`. If down: `cd
   /home/govhub/x402-cosmos && go run ./bin/facilitator ...` per its
   README.
2. **suverse-pay gateway running** on `localhost:3000`. If down:
   `docker compose up -d && pnpm db:migrate && pnpm db:bootstrap`
   then `pnpm --filter @suverse-pay/api dev`.
3. **x/authz grant fresh** — Noble testnet payer grants the
   facilitator a SendAuthorization with a 24-hour TTL. If the grant
   has expired, refresh:

   ```bash
   cd /home/govhub/x402-cosmos
   go run ./tools/grant \
     --mnemonic "$X402_PAYER_MNEMONIC" \
     --grantee  "$X402_FACILITATOR_GRANTEE" \
     --spend-limit 1000000uusdc \
     --expiration 24h
   ```

   (Mnemonic + grantee come from
   `/home/govhub/x402-cosmos/.env`.)
4. **Funded payer wallet** — `noble1...` address derived from
   `X402_PAYER_MNEMONIC` must hold at least a few cents of USDC on
   testnet. `02` spends `0.01 USDC` per call.
5. **ADMIN_API_KEY** — sourced from `/home/govhub/suverse-pay/.env`,
   matches the gateway's hashed admin key.

## Run

```bash
bash scripts/smoke/mcp-real/run-all.sh
```

Ports (override via env):
- `MCP_PORT=3299` — MCP HTTP server
- `DEMO_PORT=8290` — x402-cosmos demo /premium endpoint

Logs land in `/tmp/suverse-pay-mcp-real/`.

## Step list

| Step | What it does |
|------|--------------|
| 00 | Verify cosmos-pay + suverse-pay healthy. Build demo server binary if missing. Spawn demo server + MCP server. Do one-time MCP transport handshake. |
| 01 | `init_session` with the funded `X402_PAYER_MNEMONIC` + `cosmos:grand-1`. Persist sessionId. |
| 02 | `pay_and_call` against `http://127.0.0.1:8290/premium`. Asserts real txHash, providerId=cosmos-pay, response.status=200, prints Mintscan URL. |
| 03 | Replay step 02. Asserts same paymentId, same txHash, `get_payment_status.attempts==1` (no second broadcast). |
| 99 | Stop demo + MCP. Leave cosmos-pay + suverse-pay running. |

## Troubleshooting

- **"grant expired" / "authorization not found"** — refresh per the
  pre-conditions above. Grants are 24-hour by default.
- **"unparseable_402"** — demo server middleware version drift.
  pay_and_call supports both v1 (body) and v2 (PAYMENT-REQUIRED
  header) formats; check the demo server's `Access-Control-Expose-Headers`.
- **"insufficient_funds"** — payer USDC balance is below `0.01`. Top
  up via Noble testnet faucet.
- **Slow first run** — first `go build` of the demo server takes
  ~10–30s; the binary is cached at `/tmp/x402-demo-server` for
  subsequent runs.
