/**
 * Fastify + @suverselabs/x402-server middleware snippet.
 *
 * Mirrors the Express template but uses `preHandler` registration.
 */

import type { RenderedSnippet, TemplateInput } from "./types.js";

export function renderFastify(input: TemplateInput): RenderedSnippet {
  const acceptedPaymentsBlock = input.acceptedPayments
    .map(
      (p) => `    {
      // ${p.networkLabel}
      scheme: "exact",
      network: "${p.network}",
      asset: "${p.asset}",
      payTo: "${p.payTo}",
      maxAmountRequired: "${p.maxAmountRequired}",
    }`,
    )
    .join(",\n");

  const descriptionLine =
    input.description !== null && input.description !== ""
      ? `\n  description: ${JSON.stringify(input.description)},`
      : "";

  const code = `// Suverse Pay — Fastify integration snippet
// Generated for resource key ${input.keyId} on ${input.timestamp}
//
// 1. Install dependencies (see install command below)
// 2. Set SUVERSE_PAY_API_KEY in your .env
// 3. Drop this file into your project and replace the handler with
//    your own business logic

import Fastify from "fastify";
import { createFastifyPreHandler } from "@suverselabs/x402-server/fastify";

const app = Fastify({ logger: true });

const x402 = createFastifyPreHandler({
  apiKey: process.env.SUVERSE_PAY_API_KEY,
  facilitator: "${input.facilitatorUrl}",
  acceptedPayments: [
${acceptedPaymentsBlock},
  ],${descriptionLine}
});

app.post("/paid", { preHandler: x402 }, async (request) => {
  // request.x402Payment carries the receipt: payer, txHash, network.
  return {
    result: "your paid response goes here",
    paidBy: request.x402Payment?.payer ?? null,
    txHash: request.x402Payment?.txHash ?? null,
  };
});

await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
`;

  return {
    framework: "fastify",
    language: "javascript",
    code,
    envVars: ["SUVERSE_PAY_API_KEY=sup_live_<paste-yours-here>"],
    install: "npm install fastify @suverselabs/x402-server",
    middlewareStatus: "published",
  };
}
