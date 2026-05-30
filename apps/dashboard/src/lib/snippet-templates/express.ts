/**
 * Express + @suverselabs/x402-server middleware snippet.
 *
 * Generates a working server skeleton: the seller copies it into a
 * new file, runs `npm install` against the listed packages, drops in
 * their handler, sets the env var, and they're live.
 */

import type { RenderedSnippet, TemplateInput } from "./types.js";

export function renderExpress(input: TemplateInput): RenderedSnippet {
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
      ? `\n    description: ${JSON.stringify(input.description)},`
      : "";

  const code = `// Suverse Pay — Express integration snippet
// Generated for resource key ${input.keyId} on ${input.timestamp}
//
// 1. Install dependencies (see install command below)
// 2. Set SUVERSE_PAY_API_KEY in your .env (paste the plaintext you
//    copied when you created the key — we don't store it)
// 3. Drop this file into your project and replace the handler at the
//    bottom with your own business logic
// 4. Run \`node server.js\` and hit your paid route — the first call
//    will receive HTTP 402; the second (with X-Payment) will pay
//    through https://facilitator.suverse.io and reach your handler

import express from "express";
import { createExpressMiddleware } from "@suverselabs/x402-server/express";

const app = express();

app.use(
  "/paid",
  createExpressMiddleware({
    apiKey: process.env.SUVERSE_PAY_API_KEY,
    facilitator: "${input.facilitatorUrl}",
    acceptedPayments: [
${acceptedPaymentsBlock},
    ],${descriptionLine}
  }),
);

app.get("/paid", (req, res) => {
  // The middleware has already verified + settled the payment.
  // \`req.x402Payment\` contains the receipt: payer, network, txHash, raw.
  res.json({
    result: "your paid response goes here",
    paidBy: req.x402Payment?.payer ?? null,
    txHash: req.x402Payment?.txHash ?? null,
  });
});

app.listen(process.env.PORT ?? 3000, () => {
  console.log("listening on", process.env.PORT ?? 3000);
});
`;

  return {
    framework: "express",
    language: "javascript",
    code,
    envVars: ["SUVERSE_PAY_API_KEY=sup_live_<paste-yours-here>"],
    install: "npm install express @suverselabs/x402-server",
    middlewareStatus: "published",
  };
}
