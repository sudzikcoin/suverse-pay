# @suverse-pay/mcp

MCP server exposing the suverse-pay x402 gateway to AI agents. An
agent connects over the Model Context Protocol's streamable-HTTP
transport, holds a signing secret in memory for the lifetime of a
session, and calls paid x402 endpoints through a single `pay_and_call`
tool that handles the 402 → sign → submit → response flow.

Verified end-to-end on Noble testnet `grand-1` against the
`x402-cosmos/examples/server` demo: real `MsgExec(MsgSend)` broadcast,
idempotency proven on-chain (replay returns the same `txHash` without
minting a second transaction).

## Quick start

```bash
# 1. The suverse-pay gateway must be running (port 3000 by default).
#    See /home/govhub/suverse-pay/STATUS.md for boot instructions.

# 2. Boot the MCP server.
export SUVERSE_PAY_ADMIN_KEY="<the gateway's admin api key>"
pnpm --filter @suverse-pay/mcp run dev          # tsx watch
# OR:
pnpm --filter @suverse-pay/mcp run build && pnpm --filter @suverse-pay/mcp run start
```

The server listens on `http://127.0.0.1:3100/mcp` by default.

## Configuration

| Env var | Default | Required | Description |
|---|---|---|---|
| `MCP_PORT` | `3100` | no | HTTP port to listen on. |
| `MCP_HOST` | `127.0.0.1` | no | Bind address. |
| `SUVERSE_PAY_GATEWAY_URL` | `http://localhost:3000` | no | Base URL of the suverse-pay REST gateway. |
| `SUVERSE_PAY_ADMIN_KEY` | — | **yes** | Admin key for authenticating to the gateway (`Authorization: Bearer ...`). Server-side only; never visible to MCP clients. |
| `MCP_SESSION_TIMEOUT_MINUTES` | `30` | no | Inactivity timeout for in-memory sessions. |
| `MCP_EXTERNAL_CALL_TIMEOUT_MS` | `15000` | no | Per-request timeout when calling resource endpoints from `pay_and_call`. |
| `LOG_LEVEL` | `info` | no | Pino log level. Secrets are redacted regardless. |

## Connecting from an MCP client

### Claude Desktop / Cursor / any streamable-HTTP MCP client

```json
{
  "mcpServers": {
    "suverse-pay": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp"
    }
  }
}
```

Stdio transport is NOT wired up in v0.2.0 — only streamable HTTP.

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector http://127.0.0.1:3100/mcp
```

## Tool reference

All non-init tools require an active `sessionId`. Sessions expire
after `MCP_SESSION_TIMEOUT_MINUTES` of inactivity and are zeroed on
`end_session`.

### `init_session`

Hold a signing secret in memory and derive payer addresses for the
requested CAIP-2 networks.

```json
{
  "secret": "twelve or twenty-four BIP-39 words OR 0x<64-hex-private-key>",
  "networks": ["cosmos:grand-1", "eip155:8453"]
}
```

Returns `{ sessionId, addresses, networks, expiresAt }`.

### `list_providers`

Wraps `GET /providers` on the gateway. Returns the current provider
list, capabilities, and health summary.

### `discover_endpoints`

Aggregate paid x402 endpoints from Coinbase Bazaar (and future
catalogs). Same resource URL may appear multiple times when the
endpoint advertises payment options on different `(network, asset)`
pairs.

```json
{
  "sessionId": "...",
  "query": "weather forecast",
  "network": "eip155:8453",
  "maxPriceUsd": "0.50",
  "limit": 10
}
```

### `get_quote`

```json
{
  "sessionId": "...",
  "asset": "uusdc",
  "amount": "10000",
  "scheme": "exact_cosmos_authz",
  "preferredNetworks": ["cosmos:grand-1"],
  "optimize": "cost"
}
```

Pre-validates that every requested network is in the session's
capability set before round-tripping to the gateway.

### `pay_and_call`

The core tool. Calls a paid x402 endpoint, handles 402 by signing
locally, retries with `PAYMENT-SIGNATURE`, returns the endpoint's
response.

```json
{
  "sessionId": "...",
  "url": "https://example.com/premium",
  "method": "GET",
  "headers": { "X-Trace-Id": "..." },
  "body": null
}
```

Response on a paid endpoint:

```json
{
  "status": "settled",
  "paymentId": "mcp_<32hex>",
  "txHash": "<on-chain tx hash from PAYMENT-RESPONSE>",
  "network": "cosmos:grand-1",
  "response": {
    "status": 200,
    "headers": { "...": "...", "payment-response-decoded": "{\"success\":true,...}" },
    "body": { "...": "..." }
  }
}
```

Response on a non-402 initial call:

```json
{
  "status": "no_payment_required",
  "response": { "status": 200, "headers": { ... }, "body": ... }
}
```

Replays within the same hour bucket return the cached result with
`"idempotentReplay": true` and the same `paymentId`/`txHash` — no
second on-chain transaction. See "Architecture" for the cache key.

### `get_payment_status`

Wraps `GET /payments/:id` on the gateway. **Note**: in v0.2.0 the
`paymentId` returned by `pay_and_call` is MCP-synthetic
(`mcp_<32hex>`) and is NOT recorded in the gateway's payments table —
the gateway is only involved when an external resource server
integrates suverse-pay as its facilitator. `get_payment_status` is
useful for payments that DID go through the gateway's `/settle`
endpoint (Phase 1 resource-server integrations).

### `end_session`

```json
{ "sessionId": "..." }
```

Zeroes the secret Buffer and removes the session from the in-memory
store. Idempotent: a second call returns `{"removed": false}`. Any
subsequent tool call using the same `sessionId` fails with
`session_not_found`.

## Architecture

```
agent (MCP client)
   │  MCP streamable HTTP / JSON-RPC
   ▼
@suverse-pay/mcp (this app)
   │
   ├─ Session store         in-memory only, Buffer zeroed on destroy
   ├─ Signers               @suverse-pay/signer-{cosmos,evm}
   ├─ Discovery aggregator  @suverse-pay/discovery (Bazaar + catalogs)
   ├─ Gateway client        Bearer-authed wrapper around suverse-pay REST
   └─ Idempotency cache     in-memory, keyed by
                            sha256(payerAddress | network | url
                                   | sha256(body) | hourBucket)
```

### Where the gateway fits

The suverse-pay HTTP gateway (`apps/api`) is consumed by:

- **Resource servers** — they POST to `/settle` (with `Idempotency-Key`)
  to settle a payment via the best available facilitator. The gateway
  routes across cosmos-pay, Coinbase CDP, etc. and records the
  payment in Postgres. This is the Phase 1 use case.
- **The MCP server** — it queries `/providers`, `/quote`, and
  `/payments/:id` for visibility, BUT does NOT call `/settle` for
  `pay_and_call`. Agent-side payment follows the standard x402 flow:
  sign locally, POST `PAYMENT-SIGNATURE` to the resource server, let
  the resource server's middleware forward to its configured
  facilitator (cosmos-pay, Coinbase CDP, PayAI, or — eventually —
  suverse-pay itself).

This split matches x402 protocol semantics: the resource server picks
its facilitator (and may pick suverse-pay), the client (agent) just
signs.

### Idempotency

The MCP server maintains a per-process cache keyed by
`(payerAddress, network, url, sha256(body), hourBucket)`. A replay of
the same call within the same wall-clock hour returns the cached
result without re-signing or re-submitting — preventing a second
on-chain broadcast. The cache is lost on MCP restart, which is
acceptable because session secrets are also lost on restart.

`payerAddress` (not `sessionId`) is in the key so that a fresh MCP
session for the same wallet dedupes against a prior session's call.
`hourBucket = floor(now / 3_600_000)` so legitimate re-payment of the
same resource an hour later is not blocked.

### Wire format

`pay_and_call` writes the `PAYMENT-SIGNATURE` header as a base64-
encoded `PaymentPayload` matching the cosmos-pay middleware /
facilitator shape:

```
{ "x402Version": 2, "scheme": "...", "network": "...", "payload": { ... } }
```

We deliberately do NOT use the v2 spec's wrapper envelope with
`accepted` and `resource` siblings — the live x402-cosmos middleware
does `json.Unmarshal` into a Go struct with `Scheme` and `Network` at
the top level, which the spec envelope's `accepted.scheme` wouldn't
populate. Sending the flat shape gives broadest real-world
compatibility. For inbound 402 parsing, we accept BOTH the v2
envelope (`{accepts: [...]}`) and the cosmos-pay flat shape (single
`PaymentRequirements`).

## Zero-custody guarantees

- The `secret` argument to `init_session` is held only as a
  `Buffer` for the session lifetime.
- `Session.destroy()` overwrites the Buffer with zeros before
  dereferencing it.
- The secret is NEVER logged: the pino logger has a `redact` list
  covering `secret`, `mnemonic`, `privateKey`, `secretBytes`.
- The secret is NEVER persisted: no disk write, no DB row, no Redis.
  Sessions live in a per-process `Map`.
- The secret is NEVER transmitted: it stays inside
  `session.useSecret(...)` closures and is consumed by the signer
  packages in-process. Nothing leaves the MCP server.
- Error messages are sanitized before being returned to the client —
  the test suite asserts that the canonical BIP-39 test mnemonic word
  "abandon" never appears in any surfaced error.

The Buffer is zeroed in place, but the in-memory `String` an agent
originally passed in is owned by the caller (the SDK / Node.js
process) and may persist until GC. Treat process boundaries as the
security boundary — do not run untrusted code in the same process as
this server.

## Network support

| Network | Status | Notes |
|---|---|---|
| `cosmos:grand-1` (Noble testnet) | ✅ verified on-chain via MCP | Real `MsgExec(MsgSend)` broadcast via cosmos-pay → x402-cosmos demo server. See `scripts/smoke/mcp-real/`. |
| `eip155:8453` (Base) | ⚠ signing verified, settle deferred | EIP-712 self-consistency confirmed via `recoverTypedDataAddress` round-trip. Real Coinbase CDP settle requires a CDP API key (Phase 3+). |
| `eip155:137` (Polygon) | ⚠ signing verified, settle deferred | Same as Base. |
| `eip155:42161` (Arbitrum) | ⚠ signing verified, settle deferred | Same as Base. |
| `eip155:1` (Ethereum mainnet) | ❌ session-init only | Derivation supported; no signing table entry. |
| `cosmos:noble-1` (Cosmos mainnet) | ❌ intentionally absent | No funded mainnet facilitator yet. |

## Limitations / not yet supported

- **EVM real-network smoke** — defers until we have a CDP API key.
  Phase 1 already covers Coinbase CDP at the gateway adapter level
  in mocked mode (`scripts/smoke/mocked/`); MCP's EVM path is
  validated via the EIP-712 round-trip recovery test.
- **Solana** — no signer in v0.2.0. Leading Phase 3 candidate given
  Solana's share of public Bazaar volume.
- **Permit2 fallback** for ERC-20s that don't implement EIP-3009.
  USDC and EURC are covered by EIP-3009; USDT and DAI would need
  Permit2.
- **Cosmos mainnet** (`cosmos:noble-1`). Phase 2 is testnet-only.
- **Stdio MCP transport.** Only streamable HTTP is wired up. The
  protocol layer is the same; adding stdio is a small SDK swap.
- **Per-call provider override.** `pay_and_call` uses the FIRST
  compatible `accepts[]` entry. Phase 3 will add an `optimize` hint.

## Testing

```bash
pnpm --filter @suverse-pay/mcp test
```

40 tests across 4 files:

- `src/session.test.ts` — 13 session-store lifecycle tests.
- `src/tools/init-session.test.ts` — 8 tests for secret-shape
  validation and address derivation.
- `src/tools/pay-and-call.test.ts` — 10 `deriveIdempotencyKey`
  property tests (incl. "does NOT include sessionId").
- `tests/pay-and-call.integration.test.ts` — 9 end-to-end tests with
  the real Cosmos / EVM signers and a `node:http` mock x402 server.

Plus the smoke suites:

- `scripts/smoke/mcp-mocked/` — 7 steps against a mock x402 + mock
  gateway. No real network. Run: `bash scripts/smoke/mcp-mocked/run-all.sh`.
- `scripts/smoke/mcp-real/` — 4 steps that broadcast a real
  `MsgExec(MsgSend)` on Noble testnet `grand-1` via the
  `x402-cosmos/examples/server` demo. Requires a fresh 24-hour
  `x/authz` grant. Run: `bash scripts/smoke/mcp-real/run-all.sh`.
