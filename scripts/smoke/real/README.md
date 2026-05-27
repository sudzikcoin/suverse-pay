# Real-network smoke suite

End-to-end verification against a live cosmos-pay facilitator on Cosmos
testnet `grand-1`. Each `05-settle.sh` run broadcasts a real
`MsgExec(MsgSend)` on chain and burns a small amount of testnet USDC
(0.01 by default). Run sparingly.

## Differences from `scripts/smoke/mocked/`

| Aspect              | mocked/                                           | real/                                                  |
| ------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| Backend             | nock-mocked HTTP in-process                       | live `cosmos-pay` facilitator on `:8402`               |
| Lifecycle           | suite boots and tears down its own mock server    | gateway + facilitator run externally                   |
| DB state            | truncates between runs                            | leaves history intact                                  |
| `/settle` impact    | zero on chain                                     | broadcasts to Noble testnet                            |
| Fixtures            | hardcoded JSON in each step                       | one signed payload generated per run                   |
| Coinbase CDP        | mocked alongside cosmos-pay                       | **skipped** — requires CDP API key                     |
| Fallback test       | `07-settle-fallback.sh`                           | **skipped** — needs a second reachable facilitator     |

## Prerequisites

1. **cosmos-pay facilitator running** on the host the suite targets
   (default `http://localhost:8402`).
   ```bash
   cd /home/govhub/x402-cosmos
   set -a && source .env && set +a
   ./bin/facilitator   # or `go run ./facilitator/cmd`
   ```
2. **suverse-pay API server running** on `BASE_URL` (default
   `http://127.0.0.1:3000`).
   ```bash
   cd /home/govhub/suverse-pay
   set -a && source .env && set +a
   pnpm --filter @suverse-pay/api run dev
   ```
3. **`ADMIN_API_KEY` exported** — must match the value the gateway
   bootstrapped against. Easiest: `set -a && source .env && set +a`
   before running this suite.
4. **`fixture` binary built** in the cosmos-pay repo:
   ```bash
   cd /home/govhub/x402-cosmos && go build -o bin/fixture ./tools/fixture
   ```
5. **Payer wallet funded** with testnet USDC (uusdc) on Noble grand-1.
   Faucet: <https://faucet.circle.com>, select "Noble Testnet".
6. **On-chain `SendAuthorization`** from payer → facilitator exists and
   covers the smoke amount. Refresh it via:
   ```bash
   cd /home/govhub/x402-cosmos
   set -a && source .env && set +a
   go run ./tools/grant \
     --mnemonic "$X402_PAYER_MNEMONIC" \
     --grantee "$X402_FACILITATOR_GRANTEE" \
     --spend-limit 1000000uusdc --expiration 24h
   ```

## Run

```bash
set -a && source .env && set +a
bash scripts/smoke/real/run-all.sh
```

Output is a per-step PASS/FAIL summary. Last `txHash` is recorded in
`$SMOKE_REAL_TMP/last-payment-id` (default `/tmp/suverse-pay-real-smoke/`)
and the script prints a Mintscan URL.

## Known limitations

- **CDP not exercised.** A second-provider fallback test is part of the
  v0.2+ release gate, not v0.1.0.
- **Race-replay terminal state.** The mocked suite documents a window
  in which a duplicate `/settle` may transiently return `pending`. The
  real suite does not exercise this race deliberately — it would
  require concurrent broadcasts.
- **Faucet-rate-limited.** Re-running back-to-back can drain testnet
  USDC faster than the faucet replenishes. The grant tool decrements
  the grant on every settle — refresh proactively.
