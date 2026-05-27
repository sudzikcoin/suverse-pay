import { randomUUID } from "node:crypto";
import pino, { type Logger } from "pino";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { loadConfig, type Config } from "./config.js";
import { SessionStore } from "./session.js";
import { SUPPORTED_NETWORKS } from "./networks.js";

import {
  InitSessionInputShape,
  type InitSessionInput,
  handleInitSession,
} from "./tools/init-session.js";
import { ListProvidersInputShape, handleListProviders } from "./tools/list-providers.js";
import {
  DiscoverEndpointsInputShape,
  type DiscoverEndpointsInput,
  handleDiscoverEndpoints,
} from "./tools/discover-endpoints.js";
import { GetQuoteInputShape, handleGetQuote } from "./tools/get-quote.js";
import { PayAndCallInputShape, handlePayAndCall } from "./tools/pay-and-call.js";
import {
  GetPaymentStatusInputShape,
  handleGetPaymentStatus,
} from "./tools/get-payment-status.js";
import {
  EndSessionInputShape,
  type EndSessionInput,
  handleEndSession,
} from "./tools/end-session.js";

export interface BuiltServer {
  mcp: McpServer;
  transport: StreamableHTTPServerTransport;
  store: SessionStore;
  config: Config;
  logger: Logger;
}

function ok(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function err(code: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
  };
}

export async function buildServer(config: Config = loadConfig()): Promise<BuiltServer> {
  // pino with bindings that REDACT secret-bearing paths. Defense in depth:
  // tool handlers also never log secrets, but the redact list catches
  // accidental log.info({input}) calls that would otherwise leak.
  const logger = pino({
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        "secret",
        "*.secret",
        "input.secret",
        "*.mnemonic",
        "*.privateKey",
        "secretBytes",
      ],
      remove: true,
    },
  });

  const store = new SessionStore();
  store.startSweepLoop();

  const mcp = new McpServer(
    { name: "suverse-pay-mcp", version: "0.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "MCP server for the suverse-pay x402 gateway. " +
        `Supported networks: ${SUPPORTED_NETWORKS.join(", ")}. ` +
        "Phase 2 Sub-task 1: only init_session and end_session are implemented; other tools return stub placeholders.",
    },
  );

  mcp.registerTool(
    "init_session",
    {
      title: "Start an MCP session with a signing secret",
      description:
        "Hold a mnemonic or private key in memory for the duration of this MCP session, " +
        "derive addresses for the requested networks, and return a session ID. " +
        "The secret is NEVER logged, persisted, or transmitted. Session times out after " +
        `${Math.round(config.sessionTimeoutMs / 60000)} minutes of inactivity.`,
      inputSchema: InitSessionInputShape,
    },
    async (input: InitSessionInput): Promise<CallToolResult> => {
      const result = await handleInitSession(input, { store, config });
      if (!result.ok) return err(result.error.code, result.error.message);
      return ok(result.result);
    },
  );

  mcp.registerTool(
    "list_providers",
    {
      title: "List available payment providers",
      description:
        "Returns the configured gateway providers and their capabilities. STUB in Sub-task 1.",
      inputSchema: ListProvidersInputShape,
    },
    async (): Promise<CallToolResult> => ok(handleListProviders()),
  );

  mcp.registerTool(
    "discover_endpoints",
    {
      title: "Discover paid x402 endpoints",
      description:
        "Search across Coinbase Bazaar and Cosmos catalogs for paid x402 endpoints matching the criteria. STUB in Sub-task 1.",
      inputSchema: DiscoverEndpointsInputShape,
    },
    async (input: DiscoverEndpointsInput): Promise<CallToolResult> => ok(handleDiscoverEndpoints(input)),
  );

  mcp.registerTool(
    "get_quote",
    {
      title: "Get a payment quote",
      description:
        "Ask the gateway to quote a payment across providers, optionally optimizing for cost, latency, or success rate. STUB in Sub-task 1.",
      inputSchema: GetQuoteInputShape,
    },
    async (): Promise<CallToolResult> => ok(handleGetQuote()),
  );

  mcp.registerTool(
    "pay_and_call",
    {
      title: "Pay and call a paid x402 endpoint",
      description:
        "Calls the given URL, handles a 402 Payment Required by signing locally and settling through the gateway, then re-calls with payment proof and returns the response. STUB in Sub-task 1.",
      inputSchema: PayAndCallInputShape,
    },
    async (): Promise<CallToolResult> => ok(handlePayAndCall()),
  );

  mcp.registerTool(
    "get_payment_status",
    {
      title: "Get the status of a settled payment",
      description: "Wraps GET /payments/:id. STUB in Sub-task 1.",
      inputSchema: GetPaymentStatusInputShape,
    },
    async (): Promise<CallToolResult> => ok(handleGetPaymentStatus()),
  );

  mcp.registerTool(
    "end_session",
    {
      title: "End an MCP session",
      description:
        "Zero the secret buffer and remove the session from in-memory storage. Idempotent.",
      inputSchema: EndSessionInputShape,
    },
    async (input: EndSessionInput): Promise<CallToolResult> =>
      ok(handleEndSession(input, { store })),
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcp.connect(transport);

  return { mcp, transport, store, config, logger };
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const { transport, config: cfg, logger, store } = await buildServer(config);

  const app = createMcpExpressApp({ host: cfg.host });
  app.all("/mcp", async (req, res) => {
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      logger.error({ err: e }, "transport.handleRequest failed");
      if (!res.headersSent) res.status(500).end();
    }
  });

  const server = app.listen(cfg.port, cfg.host, () => {
    logger.info(
      { host: cfg.host, port: cfg.port, gateway: cfg.gatewayUrl },
      "suverse-pay MCP listening",
    );
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    store.stopSweepLoop();
    store.destroyAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Boot when run directly (tsx watch src/server.ts).
const isDirectInvoke =
  import.meta.url === `file://${process.argv[1] ?? ""}` ||
  import.meta.url.endsWith(process.argv[1] ?? "");
if (isDirectInvoke) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error("MCP boot failed:", e);
    process.exit(1);
  });
}
