/**
 * Public ESM entry point. Exports the server-construction helper
 * so embedders can mount us into their own MCP host without going
 * through the stdio binary.
 *
 * For the standard `npx @suverselabs/x402-mcp` flow, see ./bin.ts.
 */
export { buildServer } from "./server.js";
export { name, version } from "./meta.js";
