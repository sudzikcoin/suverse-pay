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
