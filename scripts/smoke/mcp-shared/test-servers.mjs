#!/usr/bin/env node
// Combined mock x402 resource server + mock suverse-pay gateway for
// the mcp-mocked smoke suite. Spawned by 00-setup.sh, killed by
// 99-teardown.sh.
//
// Two listeners, ports passed via env vars:
//   MOCK_X402_PORT  — x402 demo endpoint at /weather
//   MOCK_GW_PORT    — fake gateway implementing /providers, /quote,
//                     /verify, /settle (idempotent), /payments/:id
//
// All gateway responses are JSON shaped like the real gateway. Settle
// dedupes by Idempotency-Key — second call with the same key returns
// the same paymentId, proving the MCP-side Idempotency-Key is stable.

import { createServer } from "node:http";

const X402_PORT = Number(process.env.MOCK_X402_PORT ?? "0");
const GW_PORT = Number(process.env.MOCK_GW_PORT ?? "0");

if (!X402_PORT || !GW_PORT) {
  console.error("MOCK_X402_PORT and MOCK_GW_PORT are required");
  process.exit(2);
}

// ---- x402 mock ----
const x402State = { unpaid: 0, paid: 0, proofs: [] };

const x402 = createServer((req, res) => {
  if (!req.url?.startsWith("/weather")) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  const proof = req.headers["payment-signature"] ?? req.headers["x-payment"];
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!proof) {
      x402State.unpaid += 1;
      res.statusCode = 402;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        x402Version: 2,
        resource: { url: `http://127.0.0.1:${X402_PORT}/weather` },
        accepts: [{
          scheme: "exact_cosmos_authz",
          network: "cosmos:grand-1",
          amount: "10000",
          asset: "uusdc",
          payTo: "noble1t74j8lz7hwf0c3y7cpklc8agkpemagrjl672w0",
          maxTimeoutSeconds: 60,
          extra: {
            facilitator: "noble1xe8469hdzc7t65jlxwxhhp48tkk3w0uykewsuy",
            chainId: "grand-1",
          },
        }],
      }));
      return;
    }
    x402State.paid += 1;
    x402State.proofs.push(typeof proof === "string" ? proof : String(proof));
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader(
      "payment-response",
      Buffer.from(
        JSON.stringify({ success: true, transaction: "MOCK_TX", network: "cosmos:grand-1" }),
        "utf8",
      ).toString("base64"),
    );
    res.end(JSON.stringify({ weather: "sunny", tempF: 72 }));
  });
});

// ---- gateway mock ----
const gwState = {
  settleByIdem: new Map(), // idem -> response
  paymentCounter: 0,
  callLog: [],
};

const gw = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const path = req.url?.split("?")[0] ?? "";
    const method = req.method ?? "GET";
    gwState.callLog.push({ method, path });
    // Cheap auth: require a Bearer header. Don't validate value — the
    // real gateway hashes it server-side; we just need to confirm the
    // MCP server sends ANY Authorization header.
    if (!req.headers.authorization?.startsWith("Bearer ")) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ code: "unauthorized" }));
      return;
    }

    if (method === "GET" && path === "/providers") {
      respondJson(res, 200, {
        providers: [
          {
            id: "cosmos-pay",
            displayName: "cosmos-pay (Noble grand-1)",
            enabled: true,
            capabilities: [
              {
                network: "cosmos:grand-1",
                asset: "uusdc",
                scheme: "exact_cosmos_authz",
                isStatic: true,
                isDiscovered: false,
                discoveredAt: null,
              },
            ],
            health: {
              status: "healthy",
              successRate7d: 1,
              avgLatencyMs: 250,
              lastCheckAt: new Date().toISOString(),
            },
          },
        ],
      });
      return;
    }

    if (method === "POST" && path === "/quote") {
      // Parse body to mirror the real /quote shape.
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      const networks = Array.isArray(parsed.preferredNetworks) ? parsed.preferredNetworks : ["cosmos:grand-1"];
      const network = networks[0];
      respondJson(res, 200, {
        quotes: [{
          providerId: "cosmos-pay",
          network,
          asset: parsed.asset ?? "uusdc",
          scheme: parsed.scheme ?? "exact_cosmos_authz",
          estimatedFeeUsd: "0.000001",
          estimatedLatencyMs: 250,
          source: "synthetic",
        }],
        recommended: { providerId: "cosmos-pay", network, reason: "first_supported" },
      });
      return;
    }

    if (method === "POST" && path === "/settle") {
      const idem = req.headers["idempotency-key"];
      if (!idem || typeof idem !== "string") {
        respondJson(res, 400, { code: "invalid_request", message: "missing Idempotency-Key" });
        return;
      }
      const existing = gwState.settleByIdem.get(idem);
      if (existing) {
        respondJson(res, 200, existing);
        return;
      }
      gwState.paymentCounter += 1;
      const paymentId = `pay_mock_${gwState.paymentCounter.toString().padStart(4, "0")}`;
      const response = {
        paymentId,
        status: "settled",
        providerId: "cosmos-pay",
        txHash: `MOCKTX${gwState.paymentCounter}`,
        network: "cosmos:grand-1",
        amount: "10000",
        asset: "uusdc",
        payer: "noble1mockpayer",
        recipient: "noble1t74j8lz7hwf0c3y7cpklc8agkpemagrjl672w0",
        resource: `http://127.0.0.1:${X402_PORT}/weather`,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
        attempts: [{
          providerId: "cosmos-pay",
          attemptNumber: 1,
          outcome: "settled",
          errorCode: null,
          errorMessage: null,
          latencyMs: 200,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          txHash: `MOCKTX${gwState.paymentCounter}`,
        }],
      };
      gwState.settleByIdem.set(idem, response);
      respondJson(res, 200, response);
      return;
    }

    if (method === "GET" && path.startsWith("/payments/")) {
      const id = decodeURIComponent(path.slice("/payments/".length));
      for (const v of gwState.settleByIdem.values()) {
        if (v.paymentId === id) {
          respondJson(res, 200, v);
          return;
        }
      }
      respondJson(res, 404, { code: "not_found" });
      return;
    }

    respondJson(res, 404, { code: "not_found", path });
  });
});

function respondJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

await Promise.all([
  new Promise((resolve) => x402.listen(X402_PORT, "127.0.0.1", resolve)),
  new Promise((resolve) => gw.listen(GW_PORT, "127.0.0.1", resolve)),
]);

console.log(`mock-x402 listening on http://127.0.0.1:${X402_PORT}`);
console.log(`mock-gateway listening on http://127.0.0.1:${GW_PORT}`);

const shutdown = () => {
  x402.close();
  gw.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
