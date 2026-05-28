# facilitator-mocked smoke suite

Tests the public `/facilitator/*` endpoints from a **resource server's**
perspective. Added in Phase 3 Sub-task 7. The name "mocked" is slightly
misleading: 03 and 05 use a REAL signed Cosmos payload and 05
broadcasts a REAL on-chain transaction on Noble testnet `grand-1`. The
"mocked" half is the EVM verify (04) — without a Coinbase CDP API key
we can only assert the routing layer accepts the request, not that
CDP itself would.

## What's covered

| Step | Endpoint | What it asserts |
|---|---|---|
| 00-setup | n/a | Bootstraps two resource API keys via `pnpm db:bootstrap-resource-key` (main key with 60 req/min, tight key with 2 req/min for the rate-limit test) |
| 01-supported | `GET /facilitator/supported` | Open access (no auth); returns `{x402Version: 2, kinds: [...]}`; lists at least `cosmos:grand-1/exact_cosmos_authz` |
| 02-health | `GET /facilitator/health` | Open access; returns `{status: "ok", x402Version: 2}` |
| 03-verify-cosmos | `POST /facilitator/verify` | Real signed Cosmos payload (reused from the Phase 1 real-smoke fixture) → `isValid: true` |
| 04-verify-evm | `POST /facilitator/verify` | Synthetic EVM payload; routing-layer assertion only. Accepts three outcomes as PASS (see step header). |
| 05-settle-cosmos | `POST /facilitator/settle` | Real on-chain Noble testnet `MsgExec(MsgSend)` broadcast through cosmos-pay; captures `txHash` |
| 06-settle-no-auth | `POST /facilitator/settle` | No `Authorization` header → 401 + `code=unauthorized` |
| 07-settle-bad-auth | `POST /facilitator/settle` | Garbage Bearer token → 401 + `code=unauthorized` |
| 08-rate-limit | `POST /facilitator/settle` | Tight-quota key (2/min) → 429 + `Retry-After` after 3 requests |
| 09-idempotency | `POST /facilitator/settle` | Replay 05's payload with the same key → returns the SAME `transaction`; no second on-chain broadcast |
| 99-teardown | n/a | Marks both resource keys `is_active=FALSE`; wipes the plaintext key files from `/tmp` |

## What's real vs mocked

- **Real**: Cosmos signing (cosmos-pay's `fixture` binary signs an ADR-036
  authz payload with the test mnemonic from `/home/govhub/x402-cosmos/.env`),
  the suverse-pay gateway, the cosmos-pay facilitator, Noble testnet
  `grand-1`. Step 05 produces a real on-chain transaction with a real
  Mintscan-viewable txHash.
- **Mocked**: The EVM payload in 04 is a hand-crafted PaymentPayload with
  zero-filled signature bytes; it would never pass a real CDP `/verify`.
  Step 04 tests the routing layer (is the EVM adapter wired? does
  `/facilitator/verify` correctly dispatch on `eip155:*`?), NOT CDP's
  signature recovery. The CDP real-network smoke is deferred to v0.3.1
  (Sub-task 4) pending a CDP API key.

## Running

```bash
# Make sure suverse-pay and cosmos-pay are both up.
curl -sf http://localhost:3000/health
curl -sf http://localhost:8402/supported

# Source .env so DATABASE_URL is visible to the bootstrap CLI.
set -a; source /home/govhub/suverse-pay/.env; set +a

bash scripts/smoke/facilitator-mocked/run-all.sh
```

## Resource API keys

The suite bootstraps and revokes its own resource keys; you do NOT
need to pre-create them. The plaintext is stashed at
`/tmp/suverse-pay-facilitator-smoke/resource-key.plaintext` (chmod
600) for the duration of the run, then wiped by 99-teardown.

If a run is interrupted before teardown, you can manually revoke the
leftover keys via:

```bash
docker compose exec -T postgres \
  psql -U suverse -d suverse_pay \
  -c "UPDATE resource_api_keys SET is_active=FALSE WHERE label LIKE 'facilitator-smoke%';"
```

## Cosmos fixture

03 and 05 reuse `scripts/smoke/real/fixtures/signed-settle-fresh.json`,
re-generating it via `scripts/smoke/real/00-prepare-fixtures.sh` so the
nonce isn't stale. Each settle consumes the nonce, so the suite
regenerates immediately before 05 to keep 09's replay-of-same-fixture
test honest.
