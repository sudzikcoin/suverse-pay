<div align="center">

# suverse-pay

### Self-serve x402 payment infrastructure for the agentic web

Pay-per-call APIs for AI agents. Wrap any HTTPS endpoint, accept USDC on Base, Solana, Cosmos and more — settled on-chain, non-custodial, in one HTTP round-trip.

[![CI](https://github.com/sudzikcoin/suverse-pay/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sudzikcoin/suverse-pay/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Dashboard](https://img.shields.io/badge/dashboard-live-brightgreen)](https://suverse-pay.suverse.io/dashboard)
[![Facilitator](https://img.shields.io/badge/facilitator-live-brightgreen)](https://facilitator.suverse.io)

[![@suverselabs/x402-client](https://img.shields.io/npm/v/@suverselabs/x402-client?label=%40suverselabs%2Fx402-client&color=cb3837)](https://www.npmjs.com/package/@suverselabs/x402-client)
[![@suverselabs/x402-server](https://img.shields.io/npm/v/@suverselabs/x402-server?label=%40suverselabs%2Fx402-server&color=cb3837)](https://www.npmjs.com/package/@suverselabs/x402-server)
[![@suverselabs/x402-mcp](https://img.shields.io/npm/v/@suverselabs/x402-mcp?label=%40suverselabs%2Fx402-mcp&color=cb3837)](https://www.npmjs.com/package/@suverselabs/x402-mcp)

[Dashboard](https://suverse-pay.suverse.io/dashboard) · [Catalog](https://suverse-pay.suverse.io/catalog) · [Facilitator](https://facilitator.suverse.io) · [Discussions](https://github.com/sudzikcoin/suverse-pay/discussions)

</div>

---

## 🚀 Live now — first customer settle on Base

The first real customer-facing settlement landed on Base mainnet on 2026-05-31. The CoinGecko BTC/ETH price feed is wrapped behind a paid x402 endpoint, billed at $0.01 per call, settled on-chain via the published buyer SDK.

```bash
# Pay-per-call against the live endpoint
GET https://proxy.suverse.io/v1/proxy/reskey_1166628d/prices
```

First settled tx: [`0xded4…4009`](https://basescan.org/tx/0xded439c578f10c3b606264e7eec2ff691684d2c0a939b3d02cc86e0826394009) on Base · 7 successful settles · [release notes](https://github.com/sudzikcoin/suverse-pay/releases/tag/v0.5.0)

---

## Quick start

Three steps from zero to a paid endpoint of your own.

**1.** Install the buyer SDK (one-liner for any agent or script that wants to call paid APIs):

```bash
npm install @suverselabs/x402-client
```

**2.** Sign in at [`suverse-pay.suverse.io/dashboard`](https://suverse-pay.suverse.io/dashboard) and create a wrapper for your existing HTTPS API — it takes about a minute. Pick the chains you want to accept, set the price per call, paste a receive address.

**3.** Receive USDC per call. The dashboard surfaces every settle in real time; on-chain transfers land in your wallet, gateway never custodies funds.

That's it. Your endpoint now speaks HTTP 402 and any x402 client can pay you.

---

## ✨ Features

- **Self-serve proxy** — wrap any HTTPS API in a paid endpoint via a web form. No deploy step, no custom server, no infra to run.
- **Multi-chain by default** — Base, Solana, Cosmos Noble, and 14 more EVM mainnets, all behind one client. The gateway routes per payment based on cost, latency, and success rate.
- **Non-custodial** — payers settle directly to your receive address on-chain. The gateway verifies and forwards; we never hold customer funds.
- **MCP-native** — drop our [`@suverselabs/x402-mcp`](https://www.npmjs.com/package/@suverselabs/x402-mcp) server into Claude Desktop or Cursor and your agent can search the catalog and pay-and-call autonomously.
- **Smart routing + failover** — multiple facilitator providers behind one API. If Coinbase CDP is degraded, the gateway falls back to PayAI / cosmos-pay / Thirdweb / others that support the same `(network, asset, scheme)` triple.
- **Buyer dashboard** — wallet registration, agent API keys, spending limits, per-network payment history, CSV export.
- **Public catalog + MCP discovery** — every paid endpoint is auto-listed at `/catalog`, surfaced via sitemap and `/.well-known/x402`, and discoverable by agents over MCP.

---

## 🌐 Network coverage

| Network | Status | Settles verified |
|---|---|---|
| Base (Coinbase L2) | ✅ live | ✅ real customer settles on mainnet |
| Solana | ✅ live | ✅ mainnet via published buyer SDK |
| Cosmos · Noble (`noble-1`) | ✅ live | ✅ mainnet via published buyer SDK |
| Polygon, Arbitrum, Optimism, BNB Chain, Ethereum, World Chain, Avalanche, Linea, Celo, Ink, XDC, Sei, Sonic, Abstract, IoTeX, Tempo, Monad | ✅ routable | wired via Thirdweb / Binance / BofAI / MPP; mainnet smoke deferred to Phase 5 |
| TRON | ✅ routable | via BofAI; native gasfree TIP-712 signer shipped in `@suverselabs/x402-client` |
| SKALE Base | ⏳ scaffolded | testnet-only smoke; mainnet productization pending |
| TON, NEAR, Aptos, Tezos, Polkadot, Stacks, Stellar | 📣 advertised | capability-only via t402-io; Phase 5 signers required to settle |

Detailed network + asset + scheme tuples live in [`STATUS.md`](./STATUS.md).

---

## 🧩 Architecture

```
                            ┌──────────────────────────────────┐
   Pay-per-call client      │  AI agent / app / script         │
   (npm @suverselabs/       │   uses @suverselabs/x402-client  │
    x402-client or MCP)     │   or @suverselabs/x402-mcp       │
                            └──────────────┬───────────────────┘
                                           │ HTTP 402 + X-PAYMENT
                                           ▼
                            ┌──────────────────────────────────┐
   Self-serve seller API    │  proxy.suverse.io                │
   (any HTTPS URL,          │   self-serve x402 wrapper        │
    wrapped via the         │   ◇ 402 challenge                │
    dashboard form)         │   ◇ upstream health probe        │
                            │   ◇ /facilitator/settle          │
                            └──────────────┬───────────────────┘
                                           │ normalised gateway call
                                           ▼
                            ┌──────────────────────────────────┐
   Gateway                  │  facilitator.suverse.io          │
                            │   routing • fallback • ledger    │
                            │   capability + health crons      │
                            └──────────────┬───────────────────┘
                                           │
                ┌──────────────────────────┼──────────────────────────────┐
                ▼                          ▼                              ▼
        ┌───────────────┐        ┌──────────────────┐          ┌──────────────────┐
        │ Coinbase CDP  │        │ cosmos-pay (Go)  │          │ PayAI / Thirdweb /│
        │ EVM USDC      │        │ Cosmos chains    │   …      │ Binance / BofAI / │
        │ Base, Polygon │        │ noble-1 mainnet  │          │ t402-io / MPP     │
        └───────────────┘        └──────────────────┘          └──────────────────┘
```

Built on the four-layer architecture documented in [`CLAUDE.md`](./CLAUDE.md): a Fastify interface layer, an orchestration brain (`services/orchestrator`), per-provider adapters in `packages/adapters/*`, and a planned isolated native-facilitator service.

---

## 📖 Examples

### Pay-per-call a live endpoint

```ts
import { SuverseClient } from "@suverselabs/x402-client";

const client = new SuverseClient({
  payer: { network: "eip155:8453", privateKey: process.env.PAYER_BASE_PRIVATE_KEY! },
});

const res = await client.fetch(
  "https://proxy.suverse.io/v1/proxy/reskey_1166628d/prices"
);
const prices = await res.json();
console.log(prices); // { bitcoin: { usd: 67890 }, ethereum: { usd: 3456 } }
```

The SDK does the 402 dance, signs the EIP-3009 (or chain-equivalent) authorization, submits via the facilitator, and returns the upstream response transparently.

### Curl-only first request

```bash
curl -i https://proxy.suverse.io/v1/proxy/reskey_1166628d/prices
# HTTP/1.1 402 Payment Required
# Content-Type: application/json
# {
#   "x402Version": 2,
#   "accepts": [{ "scheme": "exact", "network": "eip155:8453", ... }],
#   "facilitator": "https://facilitator.suverse.io"
# }
```

The 402 body carries everything an x402 client needs to construct, sign, and submit a payment.

### Drop into Claude Desktop via MCP

```json
{
  "mcpServers": {
    "suverse-pay": {
      "command": "npx",
      "args": ["-y", "@suverselabs/x402-mcp"]
    }
  }
}
```

Tools exposed: `catalog_search`, `catalog_compare`, `buy_and_call`, `list_recent_purchases`. The agent can find paid endpoints, compare prices, and pay-and-call them autonomously.

---

## 🧪 Run it locally

If you want to hack on the gateway itself:

```bash
git clone https://github.com/sudzikcoin/suverse-pay && cd suverse-pay
pnpm install

# Postgres 15 + Redis 7 on host ports 5433 / 6380 (chosen to avoid a
# host-level Postgres / Redis on the usual 5432 / 6379).
docker compose up -d

export ADMIN_API_KEY="$(openssl rand -hex 32)"
export DATABASE_URL="postgres://suverse:suverse@localhost:5433/suverse_pay"
export REDIS_URL="redis://localhost:6380"

pnpm db:migrate       # create the schema (idempotent)
pnpm db:bootstrap     # seed the apikey_admin_default row

# Drive the gateway end-to-end against in-memory mock adapters.
bash scripts/smoke/mocked/run-all.sh

# Run the API against real facilitators (env-driven adapters)
pnpm --filter @suverse-pay/api run dev
```

Full operator runbook, smoke-suite catalog, observability setup, and adapter wiring guide in [`STATUS.md`](./STATUS.md), [`CHANGELOG.md`](./CHANGELOG.md), and [`docs/observability.md`](./docs/observability.md).

---

## 🗺️ Roadmap

| Phase | Status | Highlights |
|---|---|---|
| **1** | ✅ shipped (v0.1.0) | REST gateway, smart routing, idempotency, two adapters |
| **2** | ✅ shipped (v0.2.0) | MCP server, Cosmos + EVM signers, discovery aggregator, real on-chain MCP smoke |
| **3** | ✅ shipped (v0.3.0 / v0.3.1) | Solana signer, PayAI adapter, public `/facilitator/*` surface |
| **4** | ✅ shipped (v0.4.0) | Multi-protocol (x402 + MPP + t402), 11 namespaces, 7 adapters, Permit2 USDT |
| **5** | 🟢 **first customer live (v0.5.0)** | Self-serve proxy, buyer mode, MCP server v1, customer dashboard, real customer settles on Base |
| **6** | 🔵 next | Native non-EVM signers (TON, NEAR, Aptos, Tezos, Polkadot, Stacks, Stellar); real-network smoke per Phase-4 adapter; MPP HTTP surface for Tempo Moderato testnet; native facilitator settlement |

Detailed phase plans live in [`STATUS.md`](./STATUS.md).

---

## 🤝 Community

- 💬 [GitHub Discussions](https://github.com/sudzikcoin/suverse-pay/discussions) — Q&A, showcase, ideas
- 🐛 [Issues](https://github.com/sudzikcoin/suverse-pay/issues) — bugs and feature requests
- 📖 [Public catalog](https://suverse-pay.suverse.io/catalog) — discover paid endpoints built on suverse-pay
- ⭐ Star this repo if you're building on x402

PRs welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the workflow.

---

## License

[Apache-2.0](./LICENSE)
