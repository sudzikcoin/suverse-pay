import { randomUUID } from "node:crypto";
import pino, { type Logger } from "pino";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  BazaarSource,
  CosmosCatalogSource,
  type DiscoverySource,
} from "@suverse-pay/discovery";

import { loadConfig, type Config } from "./config.js";
import { GatewayClient } from "./gateway-client.js";
import { SessionStore } from "./session.js";
import { SUPPORTED_NETWORKS } from "./networks.js";

import {
  InitSessionInputShape,
  type InitSessionInput,
  handleInitSession,
} from "./tools/init-session.js";
import {
  ListProvidersInputShape,
  type ListProvidersInput,
  handleListProviders,
} from "./tools/list-providers.js";
import {
  DiscoverEndpointsInputShape,
  type DiscoverEndpointsInput,
  handleDiscoverEndpoints,
} from "./tools/discover-endpoints.js";
import {
  GetQuoteInputShape,
  type GetQuoteInput,
  handleGetQuote,
} from "./tools/get-quote.js";
import {
  PayAndCallInputShape,
  type PayAndCallInput,
  handlePayAndCall,
} from "./tools/pay-and-call.js";
import {
  GetPaymentStatusInputShape,
  type GetPaymentStatusInput,
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
  gateway: GatewayClient;
  discoverySources: readonly DiscoverySource[];
  config: Config;
  logger: Logger;
}

export interface BuildServerOptions {
  /** Override the GatewayClient (tests pass a fake against a mock server). */
  gateway?: GatewayClient;
  /** Override discovery sources (tests inject deterministic sources). */
  discoverySources?: readonly DiscoverySource[];
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

export async function buildServer(
  config: Config = loadConfig(),
  options: BuildServerOptions = {},
): Promise<BuiltServer> {
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

  const gateway =
    options.gateway ??
    new GatewayClient({
      baseUrl: config.gatewayUrl,
      adminKey: config.adminApiKey,
    });

  const discoverySources: readonly DiscoverySource[] =
    options.discoverySources ?? [new BazaarSource(), new CosmosCatalogSource()];

  const mcp = new McpServer(
    { name: "suverse-pay-mcp", version: "0.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "MCP server for the suverse-pay x402 gateway. " +
        `Supported networks: ${SUPPORTED_NETWORKS.join(", ")}. ` +
        "Tools: init_session, list_providers, discover_endpoints, get_quote, " +
        "pay_and_call, get_payment_status, end_session.",
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
        "Returns the configured gateway providers, their merged capabilities, and " +
        "their current health summary. Sourced from GET /providers on the gateway.",
      inputSchema: ListProvidersInputShape,
    },
    async (input: ListProvidersInput): Promise<CallToolResult> => {
      const result = await handleListProviders(input, { store, gateway });
      if (!result.ok) return err(result.error.code, result.error.message);
      return ok(result.result);
    },
  );

  mcp.registerTool(
    "discover_endpoints",
    {
      title: "Discover paid x402 endpoints",
      description:
        "Search Coinbase Bazaar (and other catalogs) for paid x402 endpoints. " +
        "Returns normalized DiscoveredEndpoint entries — same resource URL may " +
        "appear multiple times for different (network, asset) payment options.",
      inputSchema: DiscoverEndpointsInputShape,
    },
    async (input: DiscoverEndpointsInput): Promise<CallToolResult> => {
      const result = await handleDiscoverEndpoints(input, { store, sources: discoverySources });
      if (!result.ok) return err(result.error.code, result.error.message);
      return ok(result.result);
    },
  );

  mcp.registerTool(
    "get_quote",
    {
      title: "Get a payment quote",
      description:
        "Ask the gateway to quote a payment across providers, optionally optimizing for " +
        "cost, latency, or success rate. Requested networks must be in the session's " +
        "capability set or the call is rejected before reaching the gateway.",
      inputSchema: GetQuoteInputShape,
    },
    async (input: GetQuoteInput): Promise<CallToolResult> => {
      const result = await handleGetQuote(input, { store, gateway });
      if (!result.ok) return err(result.error.code, result.error.message);
      return ok(result.result);
    },
  );

  mcp.registerTool(
    "pay_and_call",
    {
      title: "Pay and call a paid x402 endpoint",
      description:
        "Calls the given URL. On HTTP 402 Payment Required, picks a compatible " +
        "accepts[] entry from the session's networks, signs locally with the in-memory " +
        "secret, POSTs to the gateway /settle endpoint with a derived Idempotency-Key, " +
        "then retries the original request with the X-PAYMENT header and returns the " +
        "endpoint's response. Non-402 initial responses are returned as-is.",
      inputSchema: PayAndCallInputShape,
    },
    async (input: PayAndCallInput): Promise<CallToolResult> => {
      const result = await handlePayAndCall(input, { store, gateway, config });
      if (!result.ok) return err(result.error.code, result.error.message);
      return ok(result.result);
    },
  );

  mcp.registerTool(
    "get_payment_status",
    {
      title: "Get the status of a settled payment",
      description: "Wraps GET /payments/:id. Returns the gateway's payment record including attempts.",
      inputSchema: GetPaymentStatusInputShape,
    },
    async (input: GetPaymentStatusInput): Promise<CallToolResult> => {
      const result = await handleGetPaymentStatus(input, { store, gateway });
      if (!result.ok) return err(result.error.code, result.error.message);
      return ok(result.result);
    },
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

  return { mcp, transport, store, gateway, discoverySources, config, logger };
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
