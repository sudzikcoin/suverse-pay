#!/usr/bin/env node
/**
 * Stdio entry point. Claude Desktop and Cursor spawn this binary
 * as a subprocess and speak MCP over stdin/stdout. Stderr is
 * reserved for diagnostic logging — anything written to stdout that
 * isn't a JSON-RPC frame breaks the protocol.
 *
 * Usage in Claude Desktop config:
 *
 *   {
 *     "mcpServers": {
 *       "suverse-x402": {
 *         "command": "npx",
 *         "args": ["-y", "@suverselabs/x402-mcp"],
 *         "env": {
 *           "BASE_PRIVATE_KEY": "0x...",
 *           "SOLANA_KEYPAIR": "base58-encoded-secret"
 *         }
 *       }
 *     }
 *   }
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The transport keeps the event loop alive; we deliberately don't
  // exit here. SIGINT / SIGTERM from the host will tear us down.
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("[suverse-x402-mcp] fatal:", err);
  process.exit(1);
});
