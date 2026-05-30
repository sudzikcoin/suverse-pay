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

export function buildServer(): McpServer {
  const server = new McpServer({
    name: pkgName,
    version: pkgVersion,
  });

  // Tool registration happens in subsequent subtasks. The server
  // starts up with zero tools today — that's intentional. A client
  // that connects can still call `listTools` and confirm the
  // handshake works.

  return server;
}
