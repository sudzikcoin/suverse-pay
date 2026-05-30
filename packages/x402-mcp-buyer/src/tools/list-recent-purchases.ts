/**
 * MCP tool: list_recent_purchases
 *
 * Reads the JSONL history file written by buy_and_call. Newest
 * first. Optional limit + sinceIso filter so an agent can ask
 * "what have I bought in the last 24h".
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { readRecentPurchases } from "../history.js";
import { atomicToUsd, formatNetworks } from "../format.js";

const inputSchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Max records to return. Default 50."),
  sinceIso: z
    .string()
    .optional()
    .describe(
      "Only include records on or after this ISO-8601 timestamp (e.g. '2026-05-30T00:00:00Z').",
    ),
  url: z
    .string()
    .optional()
    .describe("Filter to records whose URL contains this substring."),
};

export function registerListRecentPurchases(server: McpServer): void {
  server.registerTool(
    "list_recent_purchases",
    {
      title: "List recent x402 purchases by this agent",
      description:
        "Read the local purchase history written by buy_and_call. " +
        "Returns one record per paid call (url, amount, tx hash, " +
        "network, upstream status), newest first. The history file " +
        "lives in the user's local state dir; nothing leaves the " +
        "machine.",
      inputSchema,
    },
    async (args) => {
      const limit = args.limit ?? 50;
      const all = await readRecentPurchases(500);
      const cutoff =
        args.sinceIso !== undefined ? Date.parse(args.sinceIso) : null;
      if (cutoff !== null && Number.isNaN(cutoff)) {
        return {
          content: [
            {
              type: "text",
              text: `bad_iso_timestamp: could not parse '${args.sinceIso}'`,
            },
          ],
          isError: true,
          structuredContent: {
            code: "bad_iso_timestamp",
            message: args.sinceIso ?? "",
          },
        };
      }
      const filtered = all
        .filter((r) => {
          if (cutoff !== null) {
            const ts = Date.parse(r.timestamp);
            if (Number.isNaN(ts) || ts < cutoff) return false;
          }
          if (args.url && !r.url.includes(args.url)) return false;
          return true;
        })
        .slice(0, limit);

      const totalAtomic = filtered.reduce((acc, r) => {
        try {
          return acc + BigInt(r.amount);
        } catch {
          return acc;
        }
      }, 0n);

      const text = renderText(filtered, totalAtomic);
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          purchases: filtered,
          totalAtomic: totalAtomic.toString(),
          totalUsd: atomicToUsd(totalAtomic.toString()),
          count: filtered.length,
        },
      };
    },
  );
}

function renderText(
  records: ReadonlyArray<import("../history.js").PurchaseRecord>,
  totalAtomic: bigint,
): string {
  if (records.length === 0) {
    return "No purchases match this filter (or the history file is empty).";
  }
  const lines = [
    `${records.length} purchases · total ≈ $${atomicToUsd(totalAtomic.toString())}`,
    "",
  ];
  for (const r of records) {
    lines.push(
      `[${r.timestamp}] $${atomicToUsd(r.amount)} on ${formatNetworks([r.network])} → ${r.url}`,
    );
    if (r.txHash) lines.push(`    tx: ${r.txHash}`);
  }
  return lines.join("\n");
}
