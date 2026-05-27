#!/usr/bin/env node
// MCP HTTP client driver for the smoke suite. Speaks the MCP
// streamable-HTTP transport directly via fetch — no SDK dep, no TS
// compile step — so the smoke scripts can stay in plain bash.
//
// Modes:
//   node driver.mjs init <mcp-url> <session-file>
//     One-time handshake (initialize → notifications/initialized).
//     Writes the mcp-session-id to <session-file> so later calls can
//     reuse it. The MCP HTTP transport keeps state per session-id;
//     re-initialize would fail with "Server already initialized".
//
//   node driver.mjs call <mcp-url> <session-file> <tool-name> [<args-json>]
//     Reads the session-id from <session-file>, sends tools/call,
//     prints the tool handler's stringified result envelope to stdout.
//
// Exit codes:
//   0   success (or successful no-content)
//   1   driver / transport error
//   5   JSON-RPC top-level error (validation, unknown tool, etc.)
//   8   tool returned isError=true (sanitized error envelope on stdout)

import { readFileSync, writeFileSync } from "node:fs";

const [, , mode, mcpUrl, sessionFile, toolName, argsJson] = process.argv;
if (!mode || !mcpUrl || !sessionFile) {
  console.error("usage: driver.mjs init|call <mcp-url> <session-file> [<tool-name> [<args-json>]]");
  process.exit(2);
}
const args = argsJson ? JSON.parse(argsJson) : {};

const ACCEPT = "application/json, text/event-stream";

async function post(headers, payload) {
  const resp = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: ACCEPT,
      ...headers,
    },
    body: JSON.stringify(payload),
  });
  const sessionId = resp.headers.get("mcp-session-id");
  const ct = resp.headers.get("content-type") ?? "";
  const text = await resp.text();
  let body = null;
  if (ct.includes("text/event-stream")) {
    // Parse SSE: pick the first `data: <json>` line.
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data.trim().length > 0) {
          body = JSON.parse(data);
          break;
        }
      }
    }
  } else if (text.length > 0 && ct.includes("application/json")) {
    body = JSON.parse(text);
  }
  return { status: resp.status, sessionId, body, ct, raw: text };
}

async function doInit() {
  const initResp = await post({}, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "suverse-pay-smoke", version: "0.0.0" },
    },
  });
  if (initResp.status !== 200 || initResp.body?.error || !initResp.sessionId) {
    console.error(
      `mcp initialize failed: status=${initResp.status} body=${JSON.stringify(initResp.body)} raw=${initResp.raw.slice(0, 400)}`,
    );
    process.exit(3);
  }
  const sid = initResp.sessionId;
  await post({ "mcp-session-id": sid }, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });
  writeFileSync(sessionFile, sid);
  console.log(sid);
}

async function doCall() {
  if (!toolName) {
    console.error("usage: driver.mjs call <mcp-url> <session-file> <tool-name> [<args-json>]");
    process.exit(2);
  }
  let sid;
  try {
    sid = readFileSync(sessionFile, "utf8").trim();
  } catch {
    console.error(`session file ${sessionFile} not found; run \`driver.mjs init\` first`);
    process.exit(3);
  }
  const callResp = await post({ "mcp-session-id": sid }, {
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 1_000_000) + 2,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });
  if (callResp.status >= 400 || !callResp.body) {
    console.error(`mcp tools/call HTTP error: status=${callResp.status} raw=${callResp.raw.slice(0, 400)}`);
    process.exit(4);
  }
  const result = callResp.body.result;
  const err = callResp.body.error;
  if (err) {
    console.log(JSON.stringify({ jsonRpcError: err }));
    process.exit(5);
  }
  if (!result || !Array.isArray(result.content) || result.content.length === 0) {
    console.error(`mcp tools/call returned unexpected shape: ${JSON.stringify(callResp.body).slice(0, 400)}`);
    process.exit(6);
  }
  const first = result.content[0];
  if (first.type !== "text") {
    console.error(`mcp tools/call first content block is not text: ${first.type}`);
    process.exit(7);
  }
  console.log(first.text);
  if (result.isError === true) process.exit(8);
}

async function main() {
  if (mode === "init") return doInit();
  if (mode === "call") return doCall();
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}

main().catch((e) => {
  console.error(`driver error: ${e?.message ?? e}`);
  process.exit(1);
});
