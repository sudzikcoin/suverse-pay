# mcp-mocked smoke suite

End-to-end MCP smoke against a mocked x402 resource server and a
mocked suverse-pay gateway. No real network calls (except an optional
live Bazaar discovery — graceful on outage), no on-chain broadcasts.

## What this covers

| Step | Tool | Asserts |
|------|------|---------|
| 00 | (setup) | mock x402 + mock gateway + MCP server all bind |
| 01 | `init_session` | returns a sessionId and noble1… address |
| 02 | `list_providers` | gateway-shaped response with cosmos-pay enabled |
| 03 | `discover_endpoints` | real Bazaar live call returns normalized DiscoveredEndpoint entries (or `[]` gracefully if Bazaar down) |
| 04 | `get_quote` | gateway returns cosmos-pay as recommended provider |
| 05 | `pay_and_call` | full 402 → real cosmos signer → mock /settle → retry with X-PAYMENT → 200. Replay verifies same paymentId (Idempotency-Key dedup end-to-end). `get_payment_status` confirms the gateway record. |
| 06 | `end_session` | removed=true, subsequent calls fail with session_not_found, second end_session is idempotent (returns removed=false) |
| 99 | (teardown) | kills MCP + mock servers |

## What this does NOT cover

- Real on-chain settlement — that's `scripts/smoke/mcp-real/`.
- Mock x402 endpoint signature *verification* — the mock x402 accepts any non-empty payment proof. Real verification happens in cosmos-pay's smoke tests and in `mcp-real`.

## Run

```bash
bash scripts/smoke/mcp-mocked/run-all.sh
```

Ports (override via env):
- `MCP_PORT=3199` — MCP HTTP server
- `MOCK_X402_PORT=3198` — mock x402 endpoint
- `MOCK_GW_PORT=3197` — mock suverse-pay gateway

Logs land in `/tmp/suverse-pay-mcp-mocked/`.

## Architecture

```
agent
  │  MCP JSON-RPC / streamable HTTP
  ▼
driver.mjs (smoke client) ──▶ MCP server (:MCP_PORT)
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                                       ▼
        @suverse-pay/                          mock gateway (:MOCK_GW_PORT)
        signer-cosmos                                │ /providers, /quote,
        signer-evm                                   │ /settle, /payments/:id
                                                    │   (in-memory idempotency
                                                    │    by Idempotency-Key)
                                                     ▼
                                          mock x402 endpoint
                                          (:MOCK_X402_PORT)
                                            /weather
                                            402 on first hit
                                            200 on X-PAYMENT retry
```

The MCP server itself is the real binary — only the gateway and the
paid endpoint are mocked. So the signer code path, the
Idempotency-Key derivation, the session lifecycle, and the
JSON-RPC/SSE transport are all exercised exactly as in production.
