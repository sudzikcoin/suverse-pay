# @suverselabs/x402-server

[![npm](https://img.shields.io/npm/v/@suverselabs/x402-server?label=npm&color=4f46e5)](https://www.npmjs.com/package/@suverselabs/x402-server)
[![license](https://img.shields.io/npm/l/@suverselabs/x402-server?color=4f46e5)](./LICENSE)

Express and Fastify middleware that turns any HTTP route into a paid
endpoint, settling stablecoin payments through a remote x402
facilitator (default: `https://facilitator.suverse.io`).

As of **v0.3.0** the middleware auto-discovers network-specific
infrastructure data (Solana `feePayer`, Cosmos grantee address, EVM
EIP-712 USDC domain) from the facilitator's `/supported` endpoint and
merges it into every 402 challenge — sellers configure only what they
own (`payTo`, `maxAmountRequired`, scheme) and never need to know
adapter-internal addresses.

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
| `disableAutoDiscover` | no | `false` | Skip facilitator-extras auto-discovery; use only the `extra` you put on each accept entry (v0.2.0 behavior). |
| `facilitatorExtrasCacheTtlMs` | no | `3_600_000` (1 h) | In-process TTL for the cached `/supported` response. |

## Auto-discovery of per-kind `extra` (v0.3.0+)

The middleware calls `GET ${facilitator}/facilitator/supported` once at
boot, caches the response per facilitator URL, and merges the
per-kind `extra` into every 402 challenge it issues.

What lives in `extra` depends on the network:

| Network family | Auto-discovered fields |
| --- | --- |
| Solana | `feePayer` (the facilitator's co-signer pubkey) |
| Cosmos | `facilitator` (grantee bech32), `chainId`, `decimals`, `symbol` |
| EVM | `name`, `version` (EIP-712 USDC domain — emitted only by facilitators that publish it) |

This means a minimal x402 seller can ship a Solana endpoint with
zero hardcoded infrastructure data:

```ts
acceptedPayments: [
  {
    scheme: "exact",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    payTo: "MyMerchantSolanaAddress",
    maxAmountRequired: "70000",
    // No `extra: { feePayer: ... }` — facilitator fills it in.
  },
]
```

### Merge precedence — seller wins

If you DO set `extra` on an accept entry, your values override the
facilitator's per key:

```ts
extra: {
  name: "USD Coin",   // pinned by seller — wins
  version: "2",       // pinned by seller — wins
  // facilitator's other keys flow through (e.g. for compatibility shims)
}
```

This keeps pre-v0.3.0 configs working unchanged.

### Failure mode

If the facilitator is unreachable, returns a non-200, or sends a body
the middleware doesn't recognise, auto-discovery falls back silently
to seller-only `extra` (matching v0.2.0 behavior). A warning is logged
once per TTL window via `opts.logger`. The middleware never throws to
your boot path because of an unreachable facilitator.

### Explicit control

If you'd rather wire auto-discovery into your app's boot sequence
yourself, set `disableAutoDiscover: true` and call the helpers
directly:

```ts
import { warmFacilitatorCache } from "@suverselabs/x402-server";

await warmFacilitatorCache("https://facilitator.suverse.io");
```

Or read individual kinds:

```ts
import { getFacilitatorExtras } from "@suverselabs/x402-server";

const extra = await getFacilitatorExtras(
  "https://facilitator.suverse.io",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "exact",
);
console.log(extra?.feePayer);
```

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

- **v0.3 (2026-05-30)** — facilitator-extras auto-discovery + signers map
  consumption from `/facilitator/supported`. Sellers no longer need to
  hardcode `extra` per network.
- v0.2 (2026-05-30) — x402 v2 ecosystem-client interop
  (Coinbase-flavour `accepts` shape, `PAYMENT-SIGNATURE` header).
- v0.1 — Express + Fastify adapters. Verify + settle through any
  facilitator that implements the x402 v2 spec.
- Python (FastAPI / Starlette / Flask) — next.

See [`CHANGELOG.md`](./CHANGELOG.md) for the full history.

## License

Apache-2.0
