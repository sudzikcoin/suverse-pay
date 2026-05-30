/**
 * Construct the MCP server instance and register tools. Pure
 * server-construction logic — the transport (stdio for Claude
 * Desktop, websockets for some IDEs) is wired in bin.ts so unit
 * tests can drive the server without spawning a process.
 *
 * Each tool registered here delegates to a thin handler module so
 * the server file stays a registry / wiring file.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { name as pkgName, version as pkgVersion } from "./meta.js";
import { registerBuyAndCall } from "./tools/buy-and-call.js";
import { registerCatalogSearch } from "./tools/catalog-search.js";

export function buildServer(): McpServer {
  const server = new McpServer({
    name: pkgName,
    version: pkgVersion,
  });

  registerCatalogSearch(server);
  registerBuyAndCall(server);

  return server;
}
