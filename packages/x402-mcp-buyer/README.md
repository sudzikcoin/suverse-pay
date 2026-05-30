# @suverselabs/x402-mcp

Model Context Protocol server for **buyer-side x402**. Lets an AI agent — Claude Desktop, Cursor, anything that speaks MCP — discover paid HTTP APIs across the suverse-pay catalog and the wider x402 ecosystem, compare them, and call them with automatic USDC payment.

> **Buyers** install this. Sellers want [`@suverselabs/x402-server`](https://www.npmjs.com/package/@suverselabs/x402-server) instead.

## What it does

Four tools, surfaced to your AI client:

| Tool | What it does |
|---|---|
| `catalog_search` | Find paid x402 APIs by free-text query. Returns top matches with price, accepted networks, and a short description. |
| `catalog_compare` | Side-by-side comparison of 2–10 listings by price / chains / category. |
| `buy_and_call` | Make an HTTP request. If the response is a 402 challenge, the MCP signs + pays + retries automatically using the wallet keys you configured. Returns `{ data, payment receipt }`. |
| `list_recent_purchases` | What did this agent buy lately, totalled in USDC. Local JSONL history; nothing leaves your machine. |

Pays via [`@suverselabs/x402-client`](https://www.npmjs.com/package/@suverselabs/x402-client) — works across 18 EVM mainnets (Base/Polygon/Arbitrum/…), Solana mainnet/devnet, Cosmos Noble, TRON.

## Install

The MCP runs on demand via `npx`; no manual install needed if you wire it directly into your client config below. If you'd rather pin a version:

```bash
npm install -g @suverselabs/x402-mcp
```

## Configure for Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "suverse-x402": {
      "command": "npx",
      "args": ["-y", "@suverselabs/x402-mcp"],
      "env": {
        "BASE_PRIVATE_KEY": "0xYOUR_EVM_PRIVATE_KEY",
        "SOLANA_KEYPAIR": "base58-encoded-secret-key-from-phantom",
        "COSMOS_MNEMONIC": "twelve or twenty four bip39 words ...",
        "TRON_PRIVATE_KEY": "64hex"
      }
    }
  }
}
```

Restart Claude Desktop after editing. Set as many or as few wallets as you want — chains without a configured signer simply aren't usable for `buy_and_call`.

## Configure for Cursor

Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "suverse-x402": {
      "command": "npx",
      "args": ["-y", "@suverselabs/x402-mcp"],
      "env": {
        "BASE_PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

## Environment variables

| Var | Required? | Purpose |
|---|---|---|
| `BASE_PRIVATE_KEY` | one of the wallet vars | EVM 0x-prefixed hex (works on every supported EVM mainnet — Base, ETH, Polygon, Arbitrum, OP, etc.) |
| `EVM_PRIVATE_KEY` | alias | Preferred new name for `BASE_PRIVATE_KEY` |
| `SOLANA_KEYPAIR` | one of the wallet vars | Base58-encoded Solana secret key (Phantom → Settings → Export Private Key) |
| `COSMOS_MNEMONIC` | one of the wallet vars | 12 or 24-word BIP-39 mnemonic for your Noble wallet |
| `TRON_PRIVATE_KEY` | one of the wallet vars | 64-hex TRON private key |

You need **at least one** wallet variable. Tools fail with `no_wallets_configured` otherwise.

## Example agent prompts

> "Find me a US weather API and call it for ZIP 94110."

The agent calls `catalog_search` with `query: "weather US zip"`, picks a listing, then calls `buy_and_call` with the endpoint URL and the request body.

> "Compare the top 3 image-generation APIs."

`catalog_search` → top 3 ids → `catalog_compare` with those ids.

> "How much have I spent today?"

`list_recent_purchases` with `sinceIso: "<today midnight>"`.

## Local purchase history

Every successful `buy_and_call` appends a record to a JSONL file in your OS state dir:

- macOS / Linux: `$XDG_STATE_HOME/suverse-x402-mcp/history.jsonl` (or `~/.local/state/suverse-x402-mcp/history.jsonl`)
- Windows: `%LOCALAPPDATA%\suverse-x402-mcp\history.jsonl`

You can read it with `cat`, `jq -s`, etc. Delete the file to reset history.

## Source

Repository: <https://github.com/sudzikcoin/suverse-pay/tree/main/packages/x402-mcp-buyer>

Apache-2.0. Issues + PRs welcome.
