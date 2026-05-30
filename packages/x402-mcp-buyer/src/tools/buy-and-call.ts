/**
 * MCP tool: buy_and_call
 *
 * The MCP equivalent of `curl`: GET or POST the URL, auto-handle the
 * 402 challenge via @suverselabs/x402-client, return the upstream
 * response data plus a payment receipt (network, amount, tx hash).
 *
 * Wallet keys come from env vars at server boot (see ./wallets.ts).
 * If a chain is required by the 402 challenge and we have no signer
 * for it, the client raises NoSupportedNetworkError — surfaced to
 * the agent as a structured isError result.
 */

import { z } from "zod";
import {
  SuverseClient,
  X402ClientError,
  type Preferences,
} from "@suverselabs/x402-client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { buildWalletsFromEnv } from "../wallets.js";
import { appendPurchase, type PurchaseRecord } from "../history.js";
import { atomicToUsd, formatNetworks } from "../format.js";

const inputSchema = {
  url: z
    .string()
    .url()
    .describe("Full https URL to call. Will receive a 402 challenge."),
  method: z
    .enum(["GET", "POST", "PUT", "DELETE", "PATCH"])
    .default("GET")
    .describe("HTTP method. Default GET."),
  body: z
    .string()
    .optional()
    .describe("Request body (string). For JSON, pass a serialised JSON string."),
  contentType: z
    .string()
    .optional()
    .describe("Content-Type header for the request body."),
  headers: z
    .record(z.string())
    .optional()
    .describe("Extra headers to send. PAYMENT-SIGNATURE is added automatically."),
  listingId: z
    .string()
    .optional()
    .describe(
      "Optional catalog listing id this call corresponds to. Saved to history for later inspection.",
    ),
  preferredNetwork: z
    .string()
    .optional()
    .describe(
      "CAIP-2 hint when the seller accepts multiple chains (e.g. 'eip155:8453' to force Base).",
    ),
  avoidNetworks: z
    .array(z.string())
    .optional()
    .describe(
      "CAIP-2 chains to never pay on, even if the seller accepts them.",
    ),
};

export function registerBuyAndCall(server: McpServer): void {
  server.registerTool(
    "buy_and_call",
    {
      title: "Pay and fetch an x402-protected URL",
      description:
        "Make an HTTP request to a paid x402 endpoint. If the response " +
        "is a 402 challenge, signs an on-chain USDC payment automatically " +
        "using the wallet keys configured at server boot, retries with " +
        "the PAYMENT-SIGNATURE header, and returns the upstream JSON. " +
        "Every call is appended to a local purchase history file.",
      inputSchema,
    },
    async (args) => {
      const { wallets, configured } = buildWalletsFromEnv();
      if (configured.length === 0) {
        return errorResult(
          "no_wallets_configured",
          "Set BASE_PRIVATE_KEY (EVM), SOLANA_KEYPAIR, COSMOS_MNEMONIC, " +
            "or TRON_PRIVATE_KEY in the MCP server env so the client " +
            "can sign payments.",
        );
      }

      const preferences: Preferences = {
        ...(args.preferredNetwork
          ? { preferredNetwork: args.preferredNetwork }
          : {}),
        ...(args.avoidNetworks && args.avoidNetworks.length > 0
          ? { avoidNetworks: args.avoidNetworks }
          : {}),
      };

      const client = new SuverseClient({ wallets, preferences });
      const init: RequestInit = { method: args.method };
      const headers: Record<string, string> = { ...(args.headers ?? {}) };
      if (args.body !== undefined) {
        init.body = args.body;
        if (args.contentType) headers["content-type"] = args.contentType;
      }
      if (Object.keys(headers).length > 0) init.headers = headers;

      try {
        const result = await client.fetch(args.url, init);
        const record: PurchaseRecord = {
          timestamp: new Date().toISOString(),
          url: args.url,
          method: args.method,
          listingId: args.listingId ?? null,
          network: result.payment.network,
          amount: result.payment.amount,
          asset: result.payment.asset,
          payer: result.payment.payer,
          payTo: result.payment.payTo,
          txHash: result.payment.txHash,
          upstreamStatus: result.response.status,
        };
        // Fire-and-forget — a slow disk shouldn't slow the tool.
        appendPurchase(record).catch((e: unknown) => {
          // eslint-disable-next-line no-console
          console.error("[suverse-x402-mcp] history append failed:", e);
        });

        const text = renderSuccess(record, result.data);
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            data: result.data,
            payment: {
              network: result.payment.network,
              amount: result.payment.amount,
              asset: result.payment.asset,
              txHash: result.payment.txHash,
              payTo: result.payment.payTo,
              payer: result.payment.payer,
            },
            upstream: { status: result.response.status },
          },
        };
      } catch (e) {
        if (e instanceof X402ClientError) {
          return errorResult(e.constructor.name, e.message);
        }
        return errorResult(
          "unexpected_error",
          e instanceof Error ? e.message : String(e),
        );
      }
    },
  );
}

function renderSuccess(record: PurchaseRecord, data: unknown): string {
  const lines = [
    `Paid $${atomicToUsd(record.amount)} on ${formatNetworks([record.network])} → ${record.payTo.slice(0, 10)}…`,
    record.txHash ? `tx: ${record.txHash}` : "(no tx hash reported)",
    `upstream: HTTP ${record.upstreamStatus}`,
    "",
    "response:",
    typeof data === "string"
      ? data.length > 2000
        ? data.slice(0, 2000) + "\n…(truncated)"
        : data
      : JSON.stringify(data, null, 2).slice(0, 2000),
  ];
  return lines.join("\n");
}

function errorResult(code: string, message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
  structuredContent: { code: string; message: string };
} {
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    isError: true,
    structuredContent: { code, message },
  };
}
