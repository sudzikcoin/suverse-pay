# @suverse-pay/mcp

MCP server that lets AI agents drive the suverse-pay x402 gateway: derive
addresses from a session-scoped secret, discover paid endpoints, get
quotes, and (from Sub-task 5 onward) sign + settle + retry against any
x402-protected URL.

## Status: Phase 2 Sub-task 1

Scaffolding only. `init_session` and `end_session` are implemented; the
remaining five tools (`list_providers`, `discover_endpoints`,
`get_quote`, `pay_and_call`, `get_payment_status`) return stub
placeholders. Each placeholder names the sub-task that will wire it up.

## Dependencies

- **`@modelcontextprotocol/sdk ~1.29.0`** — pinned to the 1.29.x patch
  range. The SDK's transport API has changed in past minors; sub-tasks
  2-6 build against this exact shape (`StreamableHTTPServerTransport`,
  `createMcpExpressApp`, `mcp.registerTool`).
- **`@cosmjs/proto-signing`** — `DirectSecp256k1HdWallet.fromMnemonic`
  for Cosmos address derivation.
- **`viem`** — `mnemonicToAccount` / `privateKeyToAccount` for EVM
  derivation.
- **`zod`** — input schemas. The MCP SDK requires Zod v3.25+ or v4; this
  package uses Zod 4 (the SDK's internal default). The rest of the
  suverse-pay monorepo uses Zod 3; this package therefore does NOT
  import shared Zod schemas from `@suverse-pay/core-types`. Shared
  types are duplicated locally where needed.
- **`express`** — SDK's `createMcpExpressApp` builds on Express 5.

## Network support

Phase 2 hardcodes the following CAIP-2 networks:

| Network         | CAIP-2            | Notes                                        |
| --------------- | ----------------- | -------------------------------------------- |
| Noble testnet   | `cosmos:grand-1`  | Our verified deployment (cosmos-pay on :8402)|
| Ethereum        | `eip155:1`        | EVM derivation only; settle deferred         |
| Polygon         | `eip155:137`      | EVM derivation only; settle deferred         |
| Base            | `eip155:8453`     | EVM derivation only; settle deferred         |
| Arbitrum        | `eip155:42161`    | EVM derivation only; settle deferred         |

**`cosmos:noble-1` (mainnet Cosmos) is intentionally NOT supported in
Phase 2.** We have no funded mainnet cosmos-pay facilitator. Re-add when
a mainnet deployment exists.

EVM `settle` against Coinbase CDP is deferred to v0.3+ (requires CDP API
key). EVM address derivation works today; signing for CDP comes in
Sub-task 3.

## Configuration

| Env var                          | Default                  | Purpose                                |
| -------------------------------- | ------------------------ | -------------------------------------- |
| `MCP_PORT`                       | `3100`                   | HTTP port (NOT 3000 — that's the REST API) |
| `MCP_HOST`                       | `127.0.0.1`              | Bind address                           |
| `SUVERSE_PAY_GATEWAY_URL`        | `http://localhost:3000`  | Upstream gateway base URL              |
| `SUVERSE_PAY_ADMIN_KEY`          | (unset)                  | Admin Bearer token for the gateway. Optional in Sub-task 1; required from Sub-task 5. |
| `MCP_SESSION_TIMEOUT_MINUTES`    | `30`                     | Idle timeout before a session is destroyed |
| `LOG_LEVEL`                      | `info`                   | pino log level                         |

## Run locally

```bash
# In repo root.
pnpm --filter @suverse-pay/mcp dev
# → "suverse-pay MCP listening" on http://127.0.0.1:3100
```

Connect with the MCP inspector:

```bash
npx @modelcontextprotocol/inspector
# point it at http://127.0.0.1:3100/mcp (Streamable HTTP transport)
```

Or hit `/mcp` directly with a JSON-RPC client. Initialize:

```bash
curl -sS -X POST http://127.0.0.1:3100/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
    "protocolVersion":"2024-11-05","capabilities":{},
    "clientInfo":{"name":"smoke","version":"0"}}}'
# Save the mcp-session-id response header for subsequent requests.
```

## Zero-custody guarantees

The secret an agent hands to `init_session` (mnemonic or private key) is
held in a `Buffer` inside an in-process `Session` and never:

- written to disk, Postgres, Redis, or any external store
- logged at any level (pino's `redact` list catches incidental references)
- echoed back in error messages
- included in `JSON.stringify(session)` (custom `toJSON()` returns only
  safe fields)
- transmitted off-process

`end_session` overwrites the secret Buffer with zeros before deletion. A
background sweep (every 60s) destroys sessions idle longer than
`MCP_SESSION_TIMEOUT_MINUTES`. When the process exits, all sessions are
gone.

The Buffer is zeroed in place, but the in-memory `String` an agent
originally passed in is owned by the caller (the SDK / Node.js process)
and may persist until GC. Treat process boundaries as the security
boundary — do not run untrusted code in the same process as this server.

## Tools

| Tool                  | Status  | Sub-task that wires it up |
| --------------------- | ------- | ------------------------- |
| `init_session`        | live    | this                      |
| `end_session`         | live    | this                      |
| `list_providers`      | stub    | 5                         |
| `discover_endpoints`  | stub    | 4 (impl) + 5 (wire)       |
| `get_quote`           | stub    | 5                         |
| `pay_and_call`        | stub    | 5                         |
| `get_payment_status`  | stub    | 5                         |

Stubs return `{"status":"stub","todo":"..."}` so callers can iterate
against the tool surface before each is wired up. They are NOT errors.
