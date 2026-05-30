/**
 * Smoke test for the Express adapter. Spins up an in-process Express
 * server, makes real HTTP requests via supertest-style fetch into a
 * randomly-assigned port. Facilitator calls are mocked through
 * fetchImpl on MiddlewareOptions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { AddressInfo } from "node:net";
import { createExpressMiddleware } from "../express.js";
import type { MiddlewareOptions } from "../types.js";

const OPTS_BASE: Omit<MiddlewareOptions, "fetchImpl"> = {
  apiKey: "sup_live_test",
  facilitator: "https://facilitator.test",
  acceptedPayments: [
    {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0xUSDC",
      payTo: "0xMerchant",
      maxAmountRequired: "100000",
    },
  ],
};

function encode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

let server: Server;
let baseUrl: string;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(
  () =>
    new Promise<void>((resolve) => {
      if (server && server.listening) server.close(() => resolve());
      else resolve();
    }),
);

function start(app: express.Express): Promise<void> {
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

describe("createExpressMiddleware", () => {
  it("responds 402 with a challenge when no X-Payment", async () => {
    const app = express();
    app.use("/paid", createExpressMiddleware({ ...OPTS_BASE }));
    app.get("/paid", (_req, res) => res.json({ ok: true }));
    await start(app);

    const res = await fetch(`${baseUrl}/paid`);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.x402Version).toBe(2);
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(body.accepts[0].network).toBe("eip155:8453");
  });

  it("invokes the handler with payment receipt on success", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ isValid: true, payer: "0xpayer" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: true, transaction: "0xdeadbeef", payer: "0xpayer" }),
          { status: 200 },
        ),
      );
    const app = express();
    app.use("/paid", createExpressMiddleware({ ...OPTS_BASE, fetchImpl }));
    app.get("/paid", (req, res) =>
      res.json({
        payer: req.x402Payment?.payer ?? null,
        txHash: req.x402Payment?.txHash ?? null,
      }),
    );
    await start(app);

    const res = await fetch(`${baseUrl}/paid`, {
      headers: {
        "X-Payment": encode({
          x402Version: 2,
          scheme: "exact",
          network: "eip155:8453",
          payload: {},
        }),
        "Idempotency-Key": "tk-1",
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payer).toBe("0xpayer");
    expect(body.txHash).toBe("0xdeadbeef");
  });
});
