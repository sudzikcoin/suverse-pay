# IDEAS.md — Future product directions

Captured during Phase 1 review. These are **not active tasks**.
Do not start work on any of them without explicit user decision.

## 1. Marketplace Aggregator MCP Server

### Concept
An MCP server that aggregates discovery of paid x402 endpoints across
multiple sources: Coinbase Bazaar, Solana ecosystem catalogs, and
future Cosmos catalogs. For an agent this appears as a single unified
MCP endpoint rather than polling each marketplace separately.

### Tools exposed via MCP
- `discover_endpoints(category, max_price, network?)` — search across
  all sources, ranked by quality score
- `pay_x402_invoice(url, amount)` — route payment via suverse-pay
- `get_quality_score(endpoint_url)` — return success_rate, latency,
  last_seen

### Bazaar integration specifics
Coinbase exposes public, no-auth endpoints we can consume:
- `GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/search`
  — semantic search with filters (network, asset, scheme, payTo,
  maxUsdPrice). Quality ranking built in.
- `GET .../v2/x402/discovery/merchant?payTo=ADDR` — all endpoints
  for one merchant address.

### Differentiator
- Coinbase Bazaar indexes only endpoints settled through CDP
  Facilitator
- Solana ecosystem catalogs are Solana-specific
- This aggregator covers horizontally across chains and marketplaces
- Quality scoring augmented by suverse-pay's own payment_attempts
  data (network effect grows with gateway usage)

### Coverage gap this addresses
Bazaar does not index endpoints that settle through cosmos-pay.
Cosmos x402 endpoints currently have no central catalog. This
aggregator becomes the discovery layer for that gap while also
fronting other ecosystems.

### Prerequisites
- suverse-pay v0.1.0 released (real-network smoke passed)
- Phase 2 MCP server core working
- Some external usage signal (issue, fork, PR, or measurable
  gateway traffic) indicating product-market direction

## 2. Agent Wallet / Treasury layer

### Concept
A thin wallet layer on top of suverse-pay gateway providing budget
management, spending policies (limits, allowlists, approval
thresholds), and audit trail for AI agents. Payments are routed
through suverse-pay's multi-facilitator capability.

### Positioning in existing landscape
This space is actively occupied by Crossmint (funded, partnered
with major payment processors), AWS Bedrock AgentCore Payments
(launched May 2026), and Coinbase Payments MCP (released October
2025, integrated with major AI assistants). Any move here would
need a sharp differentiator.

The plausible differentiator is built-in multi-facilitator routing
via suverse-pay. Existing solutions tend to be tied to a single
chain ecosystem.

### Open architectural questions
- Custody model: full custodial (requires money transmitter
  licensing in US, partnership required), MPC (specialized
  cryptographic work), or delegated keys (limits supported use
  cases). Each is a different product.
- Whether this is a standalone product or a reference implementation
  showing how to use suverse-pay gateway from an agent.

### Prerequisites
- suverse-pay v0.1.0 stable
- Phase 2 MCP server with measurable traction
- Custody model decision made

## 3. Cosmos x402 ecosystem expansion

### Concept
As x402 adoption appears on Cosmos chains beyond Noble, expand
cosmos-pay to cover them. suverse-pay picks them up automatically
via the cosmos-pay adapter and runtime capability discovery.

### Candidate networks (when they enable x402)
- Osmosis, Cosmos Hub, Neutron, Injective
- Any Cosmos SDK chain with USDC support

### Why this matters
The Solana x402 ecosystem map (May 2026) shows 88+ teams building.
Cosmos currently has near-zero x402 activity. If or when Cosmos
activates, this stack (cosmos-pay + suverse-pay) is uniquely
positioned: native facilitator plus unified routing on a chain
ecosystem where no aggregator exists.

## 4. Solana signer + adapter (Phase 3 first up)

### Concept
Add a `@suverse-pay/signer-solana` package and a Solana adapter so
agents can pay endpoints on Solana through MCP. Real-world Bazaar
data captured during Phase 2 sampling shows Solana dominating live
volume — of 31 accept entries in a 20-resource Bazaar window:

- `eip155:8453` (Base) — 22
- `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` — 5
- `eip155:137` (Polygon) — 4

But by activity (settlements / volume) Solana is much larger; Base is
dominant by *count of advertised resources* (low-volume catalog
entries). Per public ecosystem maps roughly ~70% of recent x402
payment volume is on Solana. Skipping it leaves the largest live
market uncovered.

### Implementation sketch
- New CAIP-2 network: `solana:5eykt4...` (mainnet) and
  `solana:<devnet-id>` (devnet)
- Solana x402 schemes: `exact` over SPL Token transfer + signed
  partial transaction
- Signer uses `@solana/web3.js` + the Bazaar-advertised facilitator
  (`feePayer` model)
- Adapter wraps whichever Solana facilitator we settle on (PayAI is
  one candidate)

### Prerequisites
- v0.2.0 stable
- Pick a Solana facilitator to wrap (PayAI, Solana Foundation's
  reference gateway, or run our own — Solana facilitator
  implementations are publicly available)

## 5. PayAI adapter as third facilitator

### Concept
PayAI runs a Solana x402 facilitator. Wrap it as another
`@suverse-pay/adapter-payai` so the gateway can route between
cosmos-pay, Coinbase CDP, and PayAI based on `(network, asset,
scheme)`.

### Why
Solana network share + diversifying the facilitator pool. Currently
the gateway has two adapters (cosmos-pay, coinbase-cdp). The whole
"smart routing across providers" value-add is more credible with
three+ facilitators across two+ network families.

### Prerequisites
- Solana signer (item 4) — facilitator without a signer can be
  registered for discovery / quote but `pay_and_call` needs the
  signing path
- PayAI API access (likely no-auth read endpoints, signed
  facilitator-side settle)

## 6. Resource-server facilitator mode

### Concept
Let a resource server configure suverse-pay as its facilitator
(`X402_FACILITATOR_URL=http://suverse-pay-gateway:3000`). Today the
gateway's `/settle` requires `Idempotency-Key` and Bearer auth,
which the cosmos-pay middleware doesn't supply. This forces the
"agent path" we ended up with in Phase 2 (skip the gateway, sign and
submit direct).

If we add an optional facilitator-mode endpoint that's compatible
with x402 middleware's expected facilitator wire format, resource
servers can adopt suverse-pay as their cross-chain facilitator and
get smart routing for free.

### Open question
Is this a separate endpoint (`POST /facilitator/settle`) or a flag
on `/settle` that disables auth + auto-generates Idempotency-Key?
The latter is simpler; the former is cleaner for billing /
multi-tenancy.

## 7. Pay.sh / pay-skills catalog listing

### Concept
Submit suverse-pay (gateway + MCP) to the
[pay-skills](https://github.com/payskills/skills) public catalog so
agents discovering paid x402 endpoints find us alongside the rest of
the ecosystem. We already track 122 gov-API skills in pay-skills via
the separate GovHub project; this would be a sister listing for the
gateway itself.

### Why
Free discovery channel that doesn't require Bazaar indexing. Worth
revisiting once the public `/facilitator/*` surface has a stable
signup flow (entries 9 / 10 below).

### Open question
Whether the catalog entry advertises the gateway URL, the MCP URL, or
both — they're different developer audiences (resource servers vs
agent runtimes).

## 8. PayAI mainnet smoke

### Concept
Today the only real-on-chain Solana smoke runs on devnet (free PayAI
co-signing, USDC-Dev from `faucet.circle.com`). Add a mainnet variant
that:

1. Funds a fresh wallet with ~$1 USDC on Solana mainnet.
2. Runs the same flow against `solana:5eykt4...` and PayAI mainnet.
3. Asserts a real mainnet `txSignature` in
   `https://explorer.solana.com/tx/<sig>` (no `?cluster=devnet`).

### Why
PayAI mainnet behaves differently from devnet in subtle ways (higher
priority fees, stricter compute-unit caps, real co-sign latency).
Catching divergence before a resource server depends on us avoids a
production incident.

### Cost
Per-run cost is the SPL transfer fee + amount paid (we self-transfer
so amount returns, but the network fee is real). Estimated ~$0.001
per run. Capped by a `MAINNET_SMOKE_DAILY_CAP` env var.

### Prerequisites
- Phase 3 v0.3.0 stable
- Decision on which wallet funds the mainnet smoke (separate from
  any user-facing treasury)

## 9. Signup automation for public facilitator surface

### Concept
Today `/facilitator/settle` requires `Bearer <resource-key>` and
those keys are bootstrapped by hand (one row per resource server,
seeded via the same admin path as `apikey_admin_default`). For the
public surface to be useful at scale we need:

1. Self-serve resource API key issuance (one short signup form, no
   email verification yet).
2. Per-key spending limit (USD/day), enforced by the orchestrator
   from `payment_attempts` aggregates.
3. Per-key rate limit (settles/minute), enforced by Redis token bucket.
4. CLI for the operator to revoke a key on a single Redis command,
   instantly cutting off settles without a Postgres update.

### Why
The public facilitator surface only matters if resource servers can
adopt it without contacting us. Today they can't.

### Prerequisites
- Phase 3 v0.3.0 stable
- Dashboard (entry 10) — operator needs visibility into who's signed
  up and what they're settling
- Phase 4 multi-tenancy schema additions

## 10. Public dashboard

### Concept
A read-only web UI at `https://dashboard.suverse.pay` (or a path on
the gateway) showing:

- Public facilitator health: per-network success rate, p95 latency,
  recent failover events
- Live payment volume per network (last hour, last day, last week)
- For logged-in resource server operators: their own key's settle
  history, balance vs daily cap, recent errors

### Why
Public health visibility builds trust — resource servers can verify
the gateway is healthy before adopting it as their facilitator.
Operator-side visibility makes entry 9 (self-serve signup) usable.

### Tech
- Next.js + Tailwind, served from the same domain as the gateway
- Reads from the gateway's existing observability primitives
  (`/metrics/summary` for public; per-key `/dashboard/*` endpoints
  Phase 4 will add for operators)

### Prerequisites
- Phase 4 multi-tenancy + per-key auth (so the operator side has a
  real user model)
- Signup automation (entry 9) — without it, the operator dashboard
  has no users

## Discarded ideas

### Build our own Bazaar competitor
Discarded. Coinbase Bazaar exists, indexes for free, has network
effects. Better to integrate as a consumer of its API than to
compete.

### Native facilitator settlement in Phase 2
Deferred. External facilitators currently cover the verify/settle
surface. Native settlement is a separate security boundary
(isolated service, own credentials, possibly different runtime) and
significant work. Re-evaluate in Phase 4+ if signals emerge.

### Gateway-mediated settle in `pay_and_call`
Reconsidered in Phase 2 and dropped. We initially wired
`pay_and_call` to POST `/settle` on the gateway before retrying the
resource. In practice the resource server's middleware ALSO calls
its facilitator on retry, which results in a double-settle attempt
that fails. The standard x402 flow is "agent signs, resource server
settles" — that's what `pay_and_call` does today, with an in-memory
idempotency cache to prevent double broadcasts on replay.

The gateway's `/settle` is still useful — for resource servers that
configure suverse-pay as their facilitator (see idea 6).
