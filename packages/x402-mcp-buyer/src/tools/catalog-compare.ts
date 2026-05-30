/**
 * MCP tool: catalog_compare
 *
 * Input:  { ids: string[] }   // listing ids ("suverse:abc", ...)
 * Output: structured side-by-side table + markdown text rendering.
 *
 * Pure data formatting; no payment, no fetch beyond the cached
 * catalog snapshot.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getCatalog } from "../catalog/cache.js";
import { formatPriceRange, formatNetworks } from "../format.js";
import type { Listing } from "../catalog/types.js";

const inputSchema = {
  ids: z
    .array(z.string())
    .min(2)
    .max(10)
    .describe(
      "2-10 listing ids to compare side by side. Get ids from catalog_search.",
    ),
};

export function registerCatalogCompare(server: McpServer): void {
  server.registerTool(
    "catalog_compare",
    {
      title: "Compare N catalog listings side by side",
      description:
        "Pull 2–10 listings from the catalog by id and render a " +
        "comparison across price, accepted networks, verification " +
        "status, and category. Useful before calling buy_and_call on " +
        "a candidate.",
      inputSchema,
    },
    async (args) => {
      const snapshot = await getCatalog();
      const found = new Map<string, Listing>();
      const missing: string[] = [];
      for (const id of args.ids) {
        const hit = snapshot.listings.find((l) => l.id === id);
        if (hit) found.set(id, hit);
        else missing.push(id);
      }
      const rows = args.ids
        .map((id) => found.get(id))
        .filter((l): l is Listing => l !== undefined);
      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                `None of the supplied ids matched the cached catalog. ` +
                `Missing: ${missing.join(", ")}.`,
            },
          ],
          isError: true,
          structuredContent: { rows: [], missing },
        };
      }
      const text = renderTable(rows, missing);
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          rows: rows.map((l) => ({
            id: l.id,
            title: l.title,
            description: l.description,
            category: l.category,
            tags: l.tags,
            priceAtomicMin: l.priceAtomicMin,
            priceAtomicMax: l.priceAtomicMax,
            priceUnit: l.priceUnit,
            networks: l.networks,
            isVerified: l.isVerified,
            endpointUrl: l.endpointUrl,
          })),
          missing,
        },
      };
    },
  );
}

function renderTable(rows: ReadonlyArray<Listing>, missing: ReadonlyArray<string>): string {
  const lines: string[] = [];
  for (const l of rows) {
    lines.push(`▸ ${l.title}${l.isVerified ? "  ✓ verified" : ""}`);
    lines.push(`    id        ${l.id}`);
    lines.push(`    price     ${formatPriceRange(l)}`);
    lines.push(`    networks  ${formatNetworks(l.networks)}`);
    lines.push(`    category  ${l.category}`);
    if (l.tags.length > 0) lines.push(`    tags      ${l.tags.join(", ")}`);
    lines.push(`    endpoint  ${l.endpointUrl}`);
    lines.push("");
  }
  if (missing.length > 0) {
    lines.push(`Missing ids: ${missing.join(", ")}`);
  }
  return lines.join("\n");
}
