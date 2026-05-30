# @suverselabs/x402-server

Express and Fastify middleware that turns any HTTP route into a paid
endpoint, settling stablecoin payments through a remote x402
facilitator (default: `https://facilitator.suverse.io`).

```text
client                middleware                 facilitator
  │                       │                            │
  ├── GET /paid ─────────▶│                            │
  │                       ├─ no X-Payment → 402 ─◀─────│
  │◀── 402 + challenge ───┤                            │
  │                       │                            │
  │ (signs USDC payment) │                            │
  │                       │                            │
  ├── GET /paid + X-Payment ▶│                         │
  │                       ├── POST /facilitator/verify ▶│
  │                       │◀────── { isValid: true } ──┤
  │                       ├── POST /facilitator/settle ▶│
  │                       │◀── { success:true, tx:0x.. }┤
  │◀── 200 + your handler ┤                            │
```

## Install

```bash
npm install @suverselabs/x402-server
# Peer deps: install whichever you use
npm install express          # for the Express adapter
npm install fastify          # for the Fastify adapter
```

## Express

```ts
import express from "express";
import { createExpressMiddleware } from "@suverselabs/x402-server/express";

const app = express();

app.use(
  "/paid",
  createExpressMiddleware({
    apiKey: process.env.SUVERSE_PAY_API_KEY!,
    facilitator: "https://facilitator.suverse.io",
    acceptedPayments: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0xYourReceiveAddress",
        maxAmountRequired: "100000", // $0.10 USDC (6 decimals)
      },
    ],
    description: "Cool paid API",
  }),
);

app.get("/paid", (req, res) => {
  // req.x402Payment is populated by the middleware
  res.json({
    result: "data",
    payer: req.x402Payment?.payer,
    txHash: req.x402Payment?.txHash,
  });
});

app.listen(3000);
```

## Fastify

```ts
import Fastify from "fastify";
import { createFastifyPreHandler } from "@suverselabs/x402-server/fastify";

const app = Fastify();

const x402 = createFastifyPreHandler({
  apiKey: process.env.SUVERSE_PAY_API_KEY!,
  facilitator: "https://facilitator.suverse.io",
  acceptedPayments: [
    {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0xYourReceiveAddress",
      maxAmountRequired: "100000",
    },
  ],
});

app.post("/paid", { preHandler: x402 }, async (request) => {
  return { result: "data", payer: request.x402Payment?.payer };
});

await app.listen({ port: 3000 });
```

## Options

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `apiKey` | yes | — | Resource API key from the [Suverse Pay dashboard](https://suverse-pay.suverse.io) (`sup_live_*`). |
| `facilitator` | yes | — | Base URL of the facilitator. |
| `acceptedPayments` | yes | — | Non-empty array of `{ scheme, network, asset, payTo, maxAmountRequired }`. |
| `description` | no | — | Public text shown in the 402 challenge. |
| `x402Version` | no | `2` | Protocol version to advertise. |
| `settle` | no | `true` | If `false`, verify only (no on-chain settle). |
| `fetchImpl` | no | global `fetch` | Inject your own fetch (testing, custom TLS). |
| `logger` | no | silent | Pass a pino/winston-style logger for warn/error. |

## Receipt shape

After a successful payment the middleware attaches a `PaymentReceipt`
to `req.x402Payment` (Express) / `request.x402Payment` (Fastify):

```ts
{
  payer: "0x09939648B56A776de9783eaE750A7fBE725761f1",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amount: "100000",
  txHash: "0xabc..." | null, // null in verify-only mode
  raw: { /* full facilitator response */ },
}
```

## Errors

If the facilitator is unreachable or the payment payload is
malformed, the middleware writes a 4xx/5xx JSON body with the x402
challenge included so a well-behaved client can immediately retry.
The seller's handler is not invoked.

Wire-level errors thrown to your error handler are instances of
`X402Error` — re-export from the root entry:

```ts
import { X402Error } from "@suverselabs/x402-server";

app.use((err, req, res, next) => {
  if (err instanceof X402Error) {
    /* log err.code, err.statusCode */
  }
  next(err);
});
```

## Status

- v0.1 — Express + Fastify adapters. Verify + settle through any
  facilitator that implements the x402 v2 spec.
- Python (FastAPI / Starlette / Flask) — next.

## License

Apache-2.0
