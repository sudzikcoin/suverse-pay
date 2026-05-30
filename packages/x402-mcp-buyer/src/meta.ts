/**
 * Package metadata, statically exported so the MCP handshake can
 * report a real version without a JSON import (works under both
 * tsc-emitted ESM and `tsx` in dev).
 *
 * Update when bumping package.json — there's a sanity test in
 * tests/meta.test.ts that reads package.json and asserts equality.
 */
export const name = "@suverselabs/x402-mcp";
export const version = "0.0.1";
