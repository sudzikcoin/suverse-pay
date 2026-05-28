#!/usr/bin/env node
// Minimal x402 resource server for the mcp-solana real smoke suite.
// Acts as both a 402-emitting resource AND its own x402 middleware:
// forwards inbound PAYMENT-SIGNATURE proofs straight to PayAI's
// `/settle` endpoint (https://facilitator.payai.network), waits for
// Solana devnet confirmation, returns the txSignature in
// PAYMENT-RESPONSE.
//
// NOT a faithful x402 v2 server — only what the smoke needs:
//   GET /healthz                   → 200 ok
//   GET /premium  (no proof)       → 402 + Solana PaymentRequirements body
//   GET /premium  (with proof)     → forwards to PayAI, returns 200 +
//                                    success body + PAYMENT-RESPONSE
//                                    header (or 402 + errorReason on
//                                    settlement failure)
//
// Uses Node's built-in `http` module — no external deps so this script
// can run from anywhere in the workspace without a pnpm install.
//
// Env vars (all required):
//   MOCK_PORT                Port to listen on, e.g. 8291
//   X402_NETWORK             "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
//   X402_SCHEME              "exact"
//   X402_ASSET               SPL mint base58 — USDC-Dev:
//                              4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
//   X402_PAY_TO              Recipient base58 owner pubkey (self-transfer:
//                              same as payer)
//   X402_FEE_PAYER           PayAI's facilitator pubkey:
//                              2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4
//   X402_AMOUNT              Atomic units, e.g. "100" (= 0.0001 USDC-Dev)
//   PAYAI_URL                "https://facilitator.payai.network"

import { createServer } from "node:http";

const REQUIRED = [
  "MOCK_PORT",
  "X402_NETWORK",
  "X402_SCHEME",
  "X402_ASSET",
  "X402_PAY_TO",
  "X402_FEE_PAYER",
  "X402_AMOUNT",
  "PAYAI_URL",
];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`mock-x402-devnet: missing required env var ${key}`);
    process.exit(2);
  }
}

const PORT = Number(process.env.MOCK_PORT);
const NETWORK = process.env.X402_NETWORK;
const SCHEME = process.env.X402_SCHEME;
const ASSET = process.env.X402_ASSET;
const PAY_TO = process.env.X402_PAY_TO;
const FEE_PAYER = process.env.X402_FEE_PAYER;
const AMOUNT = process.env.X402_AMOUNT;
const PAYAI_URL = process.env.PAYAI_URL.replace(/\/$/, "");

const paymentRequirements = {
  scheme: SCHEME,
  network: NETWORK,
  maxAmountRequired: AMOUNT,
  asset: ASSET,
  payTo: PAY_TO,
  resource: `http://127.0.0.1:${PORT}/premium`,
  description: "mcp-solana smoke: minimal premium endpoint",
  maxTimeoutSeconds: 60,
  extra: {
    feePayer: FEE_PAYER,
    decimals: 6,
    symbol: "USDC",
  },
};

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": payload.length,
    ...extraHeaders,
  });
  res.end(payload);
}

function paymentResponseHeader(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

async function handlePremium(req, res) {
  const proofHeader =
    req.headers["payment-signature"] ?? req.headers["x-payment"];
  if (!proofHeader) {
    return sendJson(res, 402, {
      x402Version: 2,
      accepts: [paymentRequirements],
    });
  }
  const proof = Array.isArray(proofHeader) ? proofHeader[0] : proofHeader;
  let paymentPayload;
  try {
    paymentPayload = JSON.parse(
      Buffer.from(String(proof), "base64").toString("utf8"),
    );
  } catch (err) {
    return sendJson(res, 400, {
      error: `unparseable payment proof: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
  let settleResp;
  // PayAI v2 envelope: `accepted` and `resource` live INSIDE
  // paymentPayload (matching PayAINetwork/x402-echo-merchant's
  // PaymentPayload type). The outer body is just
  // {x402Version, paymentPayload, paymentRequirements}.
  // PayAI's PaymentRequirements shape (no maxAmountRequired):
  //   {scheme, network, amount, payTo, maxTimeoutSeconds, asset, extra}
  const paymentRequirementsV2 = {
    scheme: paymentRequirements.scheme,
    network: paymentRequirements.network,
    amount: paymentRequirements.maxAmountRequired,
    payTo: paymentRequirements.payTo,
    maxTimeoutSeconds: paymentRequirements.maxTimeoutSeconds,
    asset: paymentRequirements.asset,
    extra: paymentRequirements.extra,
  };
  const resourceV2 = {
    url: paymentRequirements.resource,
    description: paymentRequirements.description ?? "x402 resource",
    mimeType: "application/json",
  };
  const enrichedPayload = {
    ...paymentPayload,
    accepted: paymentRequirementsV2,
    resource: resourceV2,
  };
  const settleBodyOut = {
    x402Version: 2,
    paymentPayload: enrichedPayload,
    paymentRequirements: paymentRequirementsV2,
  };
  try {
    settleResp = await fetch(`${PAYAI_URL}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settleBodyOut),
    });
  } catch (err) {
    return sendJson(
      res,
      402,
      {},
      {
        "payment-response": paymentResponseHeader({
          success: false,
          errorReason: `payai_unreachable: ${
            err instanceof Error ? err.message : String(err)
          }`,
          transaction: "",
          network: NETWORK,
        }),
      },
    );
  }
  const text = await settleResp.text();
  let settleBody;
  try {
    settleBody = JSON.parse(text);
  } catch {
    settleBody = { raw: text };
  }

  if (!settleResp.ok || settleBody.success === false) {
    return sendJson(
      res,
      402,
      {},
      {
        "payment-response": paymentResponseHeader({
          success: false,
          errorReason: settleBody.errorReason ?? `payai_http_${settleResp.status}`,
          transaction: settleBody.transaction ?? "",
          network: NETWORK,
          payaiBody: settleBody,
        }),
      },
    );
  }

  const txSignature = settleBody.transaction ?? "";
  return sendJson(
    res,
    200,
    {
      data: "premium content for the smoke suite",
      txSignature,
    },
    {
      "payment-response": paymentResponseHeader({
        success: true,
        transaction: txSignature,
        payer: settleBody.payer ?? "",
        network: NETWORK,
      }),
    },
  );
}

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  if (req.method === "GET" && url === "/healthz") {
    return sendJson(res, 200, { ok: true, mock: "x402-devnet" });
  }
  if (req.method === "GET" && url === "/premium") {
    handlePremium(req, res).catch((err) => {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return;
  }
  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock-x402-devnet listening on http://127.0.0.1:${PORT}`);
});
