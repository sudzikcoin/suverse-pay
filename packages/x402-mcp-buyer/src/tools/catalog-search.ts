/**
 * MCP tool: catalog_search
 *
 * Input:  { query: string, limit?: number, network?: string, category?: string }
 * Output: { results: Array<{ id, title, ... , score }> }
 *
 * Combines the cached catalog snapshot with token-overlap scoring.
 * Returns both a structured payload AND a human-readable text block
 * so dumb clients that ignore structuredContent still get something
 * useful from the tool call.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getCatalog } from "../catalog/cache.js";
import { searchListings } from "../search.js";
import { formatPriceRange, formatNetworks } from "../format.js";

const inputSchema = {
  query: z.string().min(1).max(200).describe(
    "Free-text query, e.g. 'weather forecast US zip codes' or 'image generation'.",
  ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe("Max results to return. Default 10."),
  network: z
    .string()
    .optional()
    .describe(
      "Optional CAIP-2 network filter (e.g. 'eip155:8453' for Base, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc6wjsTLnYjz' for Solana mainnet).",
    ),
  category: z
    .string()
    .optional()
    .describe("Optional category filter (e.g. 'data', 'search', 'maps')."),
};

export function registerCatalogSearch(server: McpServer): void {
  server.registerTool(
    "catalog_search",
    {
      title: "Search the suverse-pay catalog",
      description:
        "Search paid x402 APIs across the suverse-pay public catalog. " +
        "Returns top matches with price, accepted networks, and a short " +
        "description so an agent can decide which one to call.",
      inputSchema,
    },
    async (args) => {
      const snapshot = await getCatalog();
      const results = searchListings(snapshot.listings, args.query, {
        limit: args.limit,
        network: args.network,
        category: args.category,
      });
      const structured = {
        results: results.map((r) => ({
          id: r.listing.id,
          title: r.listing.title,
          description: r.listing.description,
          endpointUrl: r.listing.endpointUrl,
          category: r.listing.category,
          tags: r.listing.tags,
          priceAtomicMin: r.listing.priceAtomicMin,
          priceAtomicMax: r.listing.priceAtomicMax,
          priceUnit: r.listing.priceUnit,
          networks: r.listing.networks,
          isVerified: r.listing.isVerified,
          score: Math.round(r.score * 100) / 100,
          matchedTokens: r.matchedTokens,
        })),
        totalCandidates: snapshot.listings.length,
        sources: snapshot.sources,
      };
      const text = renderText(results, snapshot.listings.length);
      return {
        content: [{ type: "text", text }],
        structuredContent: structured,
      };
    },
  );
}

function renderText(
  results: ReturnType<typeof searchListings>,
  total: number,
): string {
  if (results.length === 0) {
    return `No matches across ${total} listings. Try a broader query or drop the network/category filter.`;
  }
  const lines = [
    `Top ${results.length} of ${total} listings:`,
    "",
  ];
  for (const r of results) {
    const l = r.listing;
    lines.push(`• ${l.title}${l.isVerified ? " ✓" : ""}`);
    lines.push(
      `    id=${l.id}  price=${formatPriceRange(l)}  networks=${formatNetworks(l.networks)}`,
    );
    if (l.description) lines.push(`    ${truncate(l.description, 140)}`);
    lines.push("");
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
