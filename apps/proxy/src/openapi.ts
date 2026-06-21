/**
 * `GET /openapi.json` — the x402 discovery document for this origin.
 *
 * x402scan (and other agent-facing discovery surfaces) require an
 * OpenAPI 3.1 document at the origin's `/openapi.json` before they will
 * register or probe any endpoint. The document is built live from the
 * approved `catalog_listings` rows whose `endpoint_url` lives on this
 * origin, joined to `seller_proxy_configs` for the HTTP method, so it
 * stays in lock-step with what the proxy actually serves.
 *
 * Operations are intentionally minimal — URL, method, price metadata
 * (`x-payment-info`) and a `402` response. The full input schema and
 * accepted networks/assets are carried by the live 402 challenge, so we
 * don't duplicate (and risk drifting) them here. Discovery only needs
 * the URL to be present in the spec plus the 402 contract.
 *
 * Spec: https://x402scan.com/discovery/spec.md
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

interface ListingRow {
  endpoint_url: string;
  title: string;
  description: string | null;
  price_atomic_min: string | null;
  price_atomic_max: string | null;
  original_method: string | null;
  public_slug: string | null;
}

/** USDC has 6 decimals — render atomic units as a fixed-6dp USD string. */
function atomicToUsd(atomic: string | null): string | null {
  if (atomic == null) return null;
  const n = Number(atomic);
  if (!Number.isFinite(n)) return null;
  return (n / 1_000_000).toFixed(6);
}

export function registerOpenApiRoute(
  app: FastifyInstance,
  opts: { pool: Pool; baseUrl: string; contactEmail?: string },
): void {
  const base = opts.baseUrl.replace(/\/+$/, "");

  app.get("/openapi.json", async (_req, reply) => {
    const { rows } = await opts.pool.query<ListingRow>(
      `SELECT cl.endpoint_url,
              cl.title,
              cl.description,
              cl.price_atomic_min::text AS price_atomic_min,
              cl.price_atomic_max::text AS price_atomic_max,
              spc.original_method,
              spc.public_slug
         FROM catalog_listings cl
         LEFT JOIN seller_proxy_configs spc
           ON cl.endpoint_url = $1 || '/v1/data/' || spc.public_slug
        WHERE cl.status = 'approved'
          AND cl.endpoint_url LIKE $1 || '/v1/data/%'
        ORDER BY cl.endpoint_url`,
      [base],
    );

    const paths: Record<string, Record<string, unknown>> = {};
    for (const r of rows) {
      let path: string;
      try {
        path = new URL(r.endpoint_url).pathname;
      } catch {
        continue;
      }
      const method = (r.original_method ?? "POST").toLowerCase();
      const min = atomicToUsd(r.price_atomic_min);
      const max = atomicToUsd(r.price_atomic_max);
      const price =
        min !== null && max !== null && min === max
          ? { mode: "fixed", currency: "USD", amount: min }
          : {
              mode: "dynamic",
              currency: "USD",
              min: min ?? "0",
              max: max ?? min ?? "0",
            };

      const operation: Record<string, unknown> = {
        operationId: (r.public_slug ?? path).replace(/[^a-zA-Z0-9_]/g, "_"),
        summary: r.title,
        ...(r.description ? { description: r.description } : {}),
        "x-payment-info": { price, protocols: [{ x402: {} }] },
        responses: {
          "200": { description: "OK" },
          "402": { description: "Payment Required" },
        },
      };

      paths[path] = { ...(paths[path] ?? {}), [method]: operation };
    }

    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("cache-control", "public, max-age=300");
    return {
      openapi: "3.1.0",
      info: {
        title: "SuVerse Pay — x402 API",
        version: "1.0.0",
        description:
          "Pay-per-call x402 endpoints. Call any endpoint without payment to receive an HTTP 402 challenge carrying the price and accepted networks/assets; retry with an X-PAYMENT header to settle in USDC (Base or Solana) and receive the response.",
        ...(opts.contactEmail ? { contact: { email: opts.contactEmail } } : {}),
        "x-guidance":
          "Every endpoint is x402-paid. Prices are quoted in USD and settled in USDC on Base or Solana. Send the request unpaid first to read the 402 challenge (price, payTo, input_schema), then retry with the signed X-PAYMENT header.",
      },
      servers: [{ url: base }],
      paths,
    };
  });
}
