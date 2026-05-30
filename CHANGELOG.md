# Changelog

All notable changes to `suverse-pay` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased] — v0.5.0-alpha — Phase 5

Phase 5 has started. Iterating toward customer-facing infrastructure.

### Fixed — packages/x402-server-node (x402 v2 ecosystem-client interop)

- **Wire format aligned with `@x402/core@2.14+` (Coinbase-flavour
  x402 v2)** so out-of-the-box ecosystem clients (`@x402/fetch`,
  `@x402/express`, …) interop without custom selectors. Discovered
  by the first real production paid call against
  `https://agentos.suverse.io/v1/freight/parse_ratecon` on Base
  (2026-05-30): `@x402/fetch@2.14` threw at challenge parse before
  ever signing, because the prior shape (per-accept `resource`
  string, `maxAmountRequired` instead of `amount`, missing
  `maxTimeoutSeconds`, no top-level structured `resource`) did not
  pass `PaymentRequiredV2Schema`. With these fixes the same
  reference test wallet now settles end-to-end.
- **`buildChallenge`** emits the v2 shape: top-level
  `resource: { url, description, mimeType }`, per-accept `amount`
  (renamed from `maxAmountRequired`), per-accept `maxTimeoutSeconds`,
  and forwards optional per-accept `extra` (e.g. EIP-712 domain for
  EVM USDC, required by `@x402/evm`'s `ExactEvmScheme`).
- **`decodePaymentHeader`** accepts both the v2-nested
  (`accepted.scheme` / `accepted.network`, as `@x402/fetch` v2
  emits) and the v1-flat shape, with v2 taking precedence. v1
  legacy clients keep working unchanged.
- **`callFacilitator`** translates v2-nested decoded payloads to
  the v1-flat shape that `facilitator.suverse.io` validates
  against today (top-level `scheme`/`network`/`payload` on
  `paymentPayload`; full v1 fields — `maxAmountRequired`,
  `resource`, `description`, `mimeType`, `maxTimeoutSeconds`,
  `extra` — on `paymentRequirements`). Retains the v2 `accepted`
  /`resource` fields alongside so a future v2-native facilitator
  can read either form without another middleware change.
- **Express + Fastify adapters** read the payment payload from
  `PAYMENT-SIGNATURE` (v2 header name) with `X-PAYMENT` fallback
  (v1), and emit the challenge on `PAYMENT-REQUIRED` (base64
  JSON) plus the settle receipt on `PAYMENT-RESPONSE` (v2) +
  `X-PAYMENT-RESPONSE` (v1) headers, with the corresponding CORS
  `Access-Control-Expose-Headers` so browser-based agents can
  read them.
- **`AcceptedPayment.extra`** added to the type definition
  (optional `Record<string, unknown>`). Without this, sellers
  cannot configure the EIP-712 domain needed for EVM USDC, and
  any payment from a v2 EVM client fails at typed-data
  construction with `EIP-712 domain parameters (name, version)
  are required in payment requirements for asset 0x…`.

This is a wire-format change but a strictly compatible one for
the seller-facing API: existing `acceptedPayments` configs
continue to work. Old v1 clients keep their existing happy path
(read body, send `X-PAYMENT`). The minor version bump in the
package manifest is appropriate when this lands.

### Added — apps/dashboard (Phase 5 Block 4 Sub-task 1)

- **`@suverse-pay/dashboard`** — customer-facing Next.js 15 dashboard
  at `suverse-pay.suverse.io` (NOT yet deployed — operator runbook
  in `apps/dashboard/README.md`).
- **OAuth sign-in** via Google + GitHub (NextAuth.js v5, JWT
  sessions). Multi-tenant from day one: one OAuth user can link N
  existing resource API keys.
- **Four panels** scoped to the user's linked keys:
  - Summary cards — total settles, settled volume USDC, success
    rate, distinct networks active. 24h / 7d / 30d period toggle.
  - Volume chart — area chart, hourly buckets (24h) or daily (7d/30d).
  - Recent settles — last 50 settles with status filter pills.
    Auto-refresh every 30s; tx hashes link to the right block
    explorer per chain.
  - Network breakdown — per-network settled / failed / volume
    table. (Renamed from "per-endpoint" because
    `facilitator_payments` doesn't carry an endpoint-path column
    today — Phase 5 carry-over to extend the wire spec.)
- **API key linker** — paste an existing resource API key
  plaintext to associate it with the OAuth user.
- **Database migration** — `db/migrations/003_dashboard.sql` adds
  `dashboard_users` + `dashboard_user_resource_keys`. UUIDs are
  app-generated (Node `crypto.randomUUID`) rather than via Postgres
  `gen_random_uuid()` so the schema runs unchanged on pg-mem (the
  db test suite's backend).
- **Aesthetic direction**: editorial financial dashboard. Dark mode
  default. JetBrains Mono for figures, Inter Tight body, single
  amber accent. Restraint over decoration — no purple-gradient AI
  cliché.

### Deferred to upcoming Phase 5 sub-tasks

- Self-serve resource API key signup (no manual ops contact required)
- Per-key filter selector in the dashboard (multi-key UI)
- WebSocket / SSE real-time settles stream
- Export CSV / advanced filter UI
- Native non-EVM signers (TON, NEAR, Aptos, Tezos, Polkadot, Stacks,
  Stellar) — capability-advertised today, end-to-end signing pending
- MPP HTTP `/mpp/*` routes — waiting on Stripe's public REST surface
- Real-network mainnet smoke per Phase-4 adapter

### Tests

- Workspace turbo: 36 → **37 tasks** (added `@suverse-pay/dashboard`).
- Dashboard package: 22 tests covering util helpers + period
  arithmetic. Route handler unit tests are intentionally minimal
  (handlers are thin proxies to `queries.ts`).
- `pnpm build` 19 → **20 packages**; `pnpm test` 37/37 green.

## [v0.4.0] — 2026-05-29 — "Multi-protocol multi-chain"

Phase 4 complete. The gateway grows from "x402 across 4 networks" to
"three protocols across 11 blockchain namespaces" in a single release.
Five new facilitator adapters, Permit2 signing for USDT, Tempo via
Stripe MPP, Cosmos mainnet via t402-io, internal Grafana stack.

Tests: **36 turbo tasks green** across **19 packages**.

### Added — facilitator adapters

- **`@suverse-pay/adapter-thirdweb-x402`** — Thirdweb's Nexus
  facilitator. Opens at `https://nexus-api.thirdweb.com`, `/supported`
  + `/health` are public; `/verify` + `/settle` gated on `x-nexus-key`.
  Rolled out Ethereum + Optimism in Block 1 Sub-task 3 (`f536dc0`),
  expanded to 9 more EVM mainnets — XDC, Monad, Sonic, Sei, Abstract,
  IoTeX, Celo, Ink, Linea — in Block 2 Sub-task 5 (`92185d0`). USDC
  contracts on-chain-verified via `eth_call name()/version()/decimals()`
  per chain.

- **`@suverse-pay/adapter-binance-x402`** — Binance x402 facilitator
  on BNB Chain. Binance Pay product; auth is HMAC-SHA512 with the
  five `BinancePay-*` headers per
  `binance/binance-pay-signature-examples`. Wired against the
  documented spec — Binance has not published a public x402 endpoint
  as of 2026-05-29. Captures the canonical BSC stablecoin gotcha:
  **18-decimal** USDC + USDT (not 6 like everywhere else), with an
  explicit `$1.00 USDT = 1e18` test that prevents silent under-
  charging by 12 orders of magnitude. (Block 2 Sub-task 7, `5c2f6ba`).

- **`@suverse-pay/adapter-bofai-x402`** — BofAI's open x402
  facilitator (Apache-2.0, v0.6.0 removed API-key requirement). First
  **non-EVM, non-Solana, non-Cosmos** route in the gateway — opens
  TRON (`tron:mainnet` + `tron:nile`) plus BSC mainnet + testnet.
  TRON USDT is the single largest USDT deployment globally by volume.
  Adapter is a pure HTTP forwarder; signer-tron deferred to Phase 5.
  (Block 2 Sub-task 8, `1ba0136`).

- **`@suverse-pay/adapter-mpp-stripe`** — **Second protocol family**
  alongside x402. Wraps Stripe's Machine Payments Protocol (MPP) —
  a 402-protocol with `WWW-Authenticate: Payment` header challenges +
  `Authorization: Payment <token>` retries. Adds Tempo L1 (chainId
  4217, EVM-compatible, EIP-155) as a settlement chain. Ships the new
  `MppAdapter` interface plus wire-format primitives
  (`challengeToHeaderLine`, `credentialFromHeaderLine`, base64url
  codec) so any future MPP integration reuses them. (Block 2 Sub-task 9,
  `dff8c64`).

- **`@suverse-pay/adapter-t402-io`** — Universal USDT facilitator
  ("t402" = x402 with `t402Version` field rename, otherwise identical
  body shape). Hosted facilitator at `https://facilitator.t402.io`
  advertises **77 `(network, scheme)` tuples** across **11
  namespaces**. Cap-only registration for now (TON, NEAR, Aptos,
  Tezos, Polkadot, Stacks, Stellar await native signers); routes
  EVM USDT chains (1, 10, 137, 8453, 42161), Cosmos noble-1 mainnet
  (first Cosmos mainnet in the gateway), and Solana mainnet USDT.
  (Block 2 Sub-task 10, `200f022`).

### Added — signing

- **Permit2 PermitWitnessTransferFrom** signing path in `signer-evm`.
  Unlocks USDT and other non-EIP-3009 ERC-20 spends on every EVM
  chain we route. Canonical Permit2 contract (`0x0000…22D4…78BA3`)
  and x402ExactPermit2Proxy (`0x4020…0001`) both verified on-chain
  via `eth_getCode` on 17 EVM mainnets. EIP-712 quirk handled:
  Permit2's domain has **no `version` field** (three fields, not
  four — a synthetic version would diverge from the on-chain
  `DOMAIN_SEPARATOR`). (Sub-task 6, `341b79a`).

- **USDT token registry** (`@suverse-pay/signer-evm/usdt-tokens.ts`)
  across **9 EVM chains** — Ethereum, Optimism, Polygon (now USDT0
  via LayerZero v2), Base, Arbitrum, Celo, Avalanche, Sei, Linea —
  all on-chain-verified via `eth_call name()/symbol()/decimals()`.
  Plus BSC USDC + USDT (18 decimals) added in Sub-task 7.

### Added — observability

- **Internal Grafana stack** behind the `observability` Docker
  Compose profile. Grafana on `:3030`, Prometheus on `:9090` (30d
  retention). Prometheus-format `/metrics` endpoint on `apps/api`
  via `prom-client`. 12-panel "Facilitator Observability" dashboard
  auto-provisioned: adapter health, settles per hour by adapter,
  settles by network, settles by status, failover events table,
  top errors by adapter, rate-limit hits per resource key, top
  resource keys by volume, per-key settle counts. (Block 1 Sub-task 4,
  `b401cc8`).

### Added — networks

- **17 EVM mainnets** routed end-to-end (up from 4 entering Phase 4).
  Mainnet additions over Phase 4:
  - Block 1: World Chain mainnet + Sepolia (`62e66e3`); Avalanche +
    Fuji + Arbitrum Sepolia via PayAI (`5dd4575`); Ethereum + Optimism
    via Thirdweb (`f536dc0`).
  - Block 2: XDC (50), Monad (143), Sonic (146), Sei (1329), Abstract
    (2741), IoTeX (4689), Celo (42220), Ink (57073), Linea (59144)
    via Thirdweb (`92185d0`). BNB Chain (56) via Binance (`5c2f6ba`).
    Tempo (4217) via MPP signer entry (`dff8c64`).

- **TRON mainnet + Nile testnet** via BofAI (`1ba0136`).

- **Cosmos noble-1 MAINNET** via t402-io (`200f022`) — first Cosmos
  mainnet route in the gateway. Block 1 Sub-task 5's funded-
  facilitator approach is no longer required; cosmos-pay native USDT
  remains a Phase 5 option for operators who want gateway-controlled
  keys.

### Added — new namespaces (capability-advertised, signer pending)

`aptos:`, `near:`, `polkadot:`, `stacks:`, `stellar:`, `tezos:`,
`ton:` — all advertised via t402-io. Phase 5 native signers unlock
end-to-end settle on each.

### Changed

- **Routing config** supports multi-adapter resilience. Routing key
  remains `(network, scheme)` — namespace prefix opaque to the
  router, so adding new VM families (Sui, Aptos, TON) is a config-
  only change once their signer ships. Examples:
  - `eip155:8453:exact` → `["coinbase-cdp", "payai"]` (Sub-task 2)
  - `eip155:43114:exact` → `["payai", "thirdweb-x402"]` (Sub-task 5)
  - `eip155:56:exact` → `["binance-x402", "bofai-x402"]` (Sub-task 8)
  - `cosmos:noble-1:exact-direct` → `["t402-io"]` (Sub-task 10)

- **signer-evm dispatch** now supports both EIP-3009
  (`TransferWithAuthorization` — USDC / EURC path) and Permit2
  (`PermitWitnessTransferFrom` — USDT and any non-EIP-3009 ERC-20).
  `signPermit2UsdtAuthorization` convenience helper looks up the USDT
  registry entry per chain.

- **Adapter authentication patterns** standardized: every new adapter
  exposes env-var configurability (`{ADAPTER}_API_KEY`,
  `{ADAPTER}_BASE_URL`, …), gracefully degrades to capability-only
  mode without credentials, and surfaces a clear `unauthorized`
  error on `/verify` + `/settle` when keys are missing. Operators
  see a status line per adapter at boot.

### Architecture

- **`MppAdapter` interface** (new) lives alongside the existing
  `FacilitatorAdapter` (for x402 + t402). Distinct because MPP's wire
  format differs (header-based vs body-based) even though the verify/
  settle semantics overlap. Both interfaces share the same orchestrator
  hooks for capability advertising + health.

- **Routing key opacity** to the namespace prefix is the architectural
  bet that pays off when adding Sui / Aptos / TON in Phase 5 — only
  config changes, no router refactor.

- **`t402-io`** is wired as another `FacilitatorAdapter`
  (Option B) rather than a third protocol interface — its wire format
  is x402 with one field rename, so the adapter emits both
  `t402Version` and `x402Version` on the wire (belt + suspenders) and
  the orchestrator never knows the difference.

### Maturity disclosure

| Adapter | Real on-chain smoke | Notes |
| --- | --- | --- |
| coinbase-cdp | ✓ Base Sepolia v0.3.1 | EVM USDC battle-tested |
| cosmos-pay | ✓ Noble grand-1 v0.2.0 | Cosmos testnet battle-tested |
| payai | ✓ Solana devnet v0.3.0 | Solana battle-tested |
| thirdweb-x402 | ✗ Phase 5 (needs Nexus key) | 11 EVM mainnets routed |
| binance-x402 | ✗ Phase 5 (needs Binance Pay merchant) | Built against documented spec |
| bofai-x402 | ✗ Phase 5 (needs signer-tron) | Hosted facilitator open access |
| mpp-stripe | ✗ Phase 5 (Stripe REST surface pending) | Wire primitives ready |
| t402-io | ✗ Phase 5 (needs t402-io key) | `version: "dev"` health flag — pre-production |

### Carry-overs to Phase 5

Phase 5 priority list (full breakdown in STATUS.md):
- Native non-EVM signers — `signer-tron`, `signer-ton`, `signer-near`,
  `signer-aptos`, `signer-stellar`, `signer-tezos`, `signer-polkadot`,
  `signer-stacks`
- EIP-2612 Permit signer for EVM
- Real-network mainnet smoke per adapter
- MPP HTTP `/mpp/*` routes (waiting on Stripe REST surface)
- Multi-tenant customer dashboard + self-serve resource key signup
- Per-settle fee mechanism for revenue
- Native facilitator settlement (isolated service)
- AP2 authorization layer

## [v0.3.1] — 2026-05-28

Phase 3 patch. Closes Sub-task 4 — Coinbase CDP real-network smoke
on Base Sepolia, the last remaining deferred item from v0.3.0.

### Added

- **`scripts/smoke/real-evm/`** — 7-step real-network smoke suite
  for Coinbase CDP settlement on Base Sepolia (`eip155:84532`). Each
  `04-settle` / `06-facilitator-settle` run broadcasts a real
  `transferWithAuthorization` to Base Sepolia via CDP and asserts
  the on-chain receipt status (`eth_getTransactionReceipt`) is
  `0x1` within ~60 seconds. Exercises both the internal `/settle`
  admin surface AND the public `/facilitator/settle` surface, so
  the multi-chain facilitator surface is now real-tested on both
  Cosmos and EVM.
- **Base Sepolia (`eip155:84532`) network support**:
  - `@suverse-pay/signer-evm` — Circle's test USDC at
    `0x036CbD53842c5426634e7929541eC2318f3dCF7e` added to the
    trusted domain table. Note: the test contract's on-chain
    EIP-712 domain `name()` is `"USDC"` (not `"USD Coin"` like
    Base mainnet) — verified via `eth_call`.
  - `@suverse-pay/adapter-coinbase-cdp` — Base Sepolia capability
    registered alongside the mainnet EVM entries; CDP advertises
    `eip155:84532` (exact / upto / batch-settlement) on
    `/supported`.
  - `apps/api` — Base Sepolia added to the production CDP
    capability set.
  - `services/facilitator` — `eip155:84532:exact` routes to
    `coinbase-cdp` in the facilitator routing config.

### Fixed

- **CDP wire-format envelope translation** in the
  `coinbase-cdp` adapter. CDP's hosted facilitator implements
  `x402V2PaymentRequirements` with `amount` (not the spec's
  `maxAmountRequired`) AND requires an `accepted` field embedded
  inside the `paymentPayload` carrying the same requirements. The
  rest of the codebase uses canonical spec field names; the
  adapter's `toCdpRequest` now translates. Without this, the
  adapter's `/verify` / `/settle` against the real CDP endpoint
  always returned HTTP 400 with
  `x402V2PaymentPayload requires 'accepted'`. Caught by Sub-task 4
  on the first end-to-end attempt; covered by a new unit test
  (`translates the spec wire format to CDP's internal x402V2 shape`)
  to prevent silent regression.
- **`scripts/smoke/mocked/`** — hard-pinned `API_PORT=3333` in
  `00-setup.sh` and `07-settle-fallback.sh`. The previous
  `API_PORT="${API_PORT:-3333}"` deferred to the caller's env; once
  a long-running dev gateway started using `.env`'s `API_PORT=3000`,
  the mocked smoke would collide with `EADDRINUSE 0.0.0.0:3000`.
  Mocked smoke is a sandbox and must never use the prod port.
- **`scripts/smoke/facilitator-mocked/04-verify-evm.sh`** — added
  a fourth accepted outcome (HTTP 502 whose
  `error.details.providerId == "coinbase-cdp"`). Once CDP is wired
  with credentials, the synthetic test payload now reaches CDP,
  which rejects it at HTTP 400 (`invalid signature: R is 0`);
  `httpJson` throws on 4xx and the gateway surfaces this as 502
  with CDP attribution. This still proves the routing layer
  reached CDP — what the test was meant to check.

### Verified

- **Real Base Sepolia on-chain USDC settle via Coinbase CDP**.
  Inaugural txs (txHashes recorded in the v0.3.1 GitHub release):
  - internal `/settle` path:
    [`0x618913...c74abfd`](https://sepolia.basescan.org/tx/0x618913f76b23878b2d0db3cba83c9073f45371ff790e972c240f5771bc74abfd)
  - public `/facilitator/settle` path:
    [`0xac4ca1...39e21`](https://sepolia.basescan.org/tx/0xac4ca10622443a1c1b1d201d1e7993d86f8e263493a9a5a301fbb60f59139e21)
- **Idempotency on real CDP**: replaying `/settle` with the same
  `Idempotency-Key` AND the same signed payload returns the same
  `paymentId` + same `txHash`, with exactly one row in
  `payment_attempts` — proven by an independent
  `GET /payments/:id` lookup after the replay.
- **Both `/verify` and `/settle` paths against real CDP** on Base
  Sepolia. Verify returns `{isValid: true, payer}`; settle returns
  a 32-byte txHash that subsequently lands on-chain.
- **All 7 smoke suites green**: `mocked` (10), `real` (9),
  `mcp-mocked` (7), `mcp-real` (4), `facilitator-mocked` (10),
  `mcp-solana` (5), **`real-evm` (7 — new)**.
- CDP minimum settle amount on Base Sepolia is **1000 atomic
  USDC** (= `$0.001`). Below that CDP returns
  `{invalidReason: "amount_too_low"}`; the smoke default is now
  set there.

### Deferred

- **CDP 4xx-as-verify-result handling**. CDP returns
  `{isValid: false, invalidReason, ...}` as HTTP 400 (not 200), so
  the adapter's `verify` currently throws on every CDP rejection
  instead of returning a normalized `{valid: false, errorCode}`
  response. The CDP-attribution case is handled gracefully end to
  end, but the adapter should parse CDP 4xx bodies. Not in v0.3.1
  because the fix touches the common `httpJson` retry/throw path
  and warrants its own test surface.

## [v0.3.0] — 2026-05-28

Phase 3 stable. Solana support across signer, PayAI adapter, MCP,
and a public x402 facilitator surface. Verified real on-chain on
both Noble grand-1 (Cosmos) and Solana devnet.

### Added

- **`@suverse-pay/signer-solana`** — SPL `transferChecked` payload
  signing for the `exact` scheme on Solana mainnet (`solana:5eykt4...`)
  and devnet (`solana:EtWTRABZ...`). Builds a v0 `VersionedTransaction`
  with the required instruction layout (ComputeBudget × 2, then
  `transferChecked`, then Memo for uniqueness), partial-signs as the
  payer, and emits the canonical v2 `{paymentPayload,
  paymentRequirements}` envelope. Round-trip ed25519 verification
  asserted by the signer test suite.
- **`@suverse-pay/adapter-payai`** — PayAI facilitator adapter at
  `https://facilitator.payai.network`, registered alongside
  cosmos-pay and coinbase-cdp. Supports Solana mainnet
  (`solana:5eykt4...`) and devnet (`solana:EtWTRABZ...`) via the
  v2 schema (PayAI's wire format puts `accepted` and `resource`
  inside `paymentPayload`, distinct from the v1 envelope; the
  adapter handles the translation).
- **Coinbase CDP Solana support** in the existing `coinbase-cdp`
  adapter — declarative addition only, the wire format is
  identical to the EVM path. `(network, asset, scheme) =
  (solana:5eykt4..., USDC, exact)` is the primary route on Solana
  mainnet with PayAI as failover.
- **Public x402 facilitator surface** at `/facilitator/*` on
  `apps/api`:
  - `GET /facilitator/health` — liveness, no auth
  - `GET /facilitator/supported` — x402 spec §7.3 SupportedResponse
  - `POST /facilitator/verify` — x402 spec §7.1, no auth
  - `POST /facilitator/settle` — x402 spec §7.2, Bearer
    `<resource-key>` auth, rate-limited per key, idempotency-key
    derived from `(payer, payload-hash, hourBucket)`. Routes across
    cosmos-pay, Coinbase CDP, and PayAI based on `(network, scheme)`
    with per-route failover.
- **MCP Solana support**: `init_session` accepts a BIP-39 mnemonic
  and derives the Solana base58 address alongside the existing
  Cosmos bech32 and EVM 0x-hex addresses; `pay_and_call` selects
  the signer-solana for `solana:*` networks via the
  `selectSigner(network)` dispatch and fetches a fresh devnet /
  mainnet blockhash at sign time (the signer doesn't cache them —
  Solana drops them after ~150 slots).
- **`scripts/smoke/mcp-solana/`** — 5-step smoke that broadcasts a
  real SPL `transferChecked` on Solana devnet via PayAI. Includes a
  Node-only `mock-x402-devnet` resource server (no external deps —
  built on `node:http`) that emits 402 with v2 Solana
  `PaymentRequirements` and forwards `PAYMENT-SIGNATURE` to PayAI
  using the correct v2 envelope. Asserts a real devnet
  `txSignature` and idempotent replay.
- **`scripts/smoke/facilitator-mocked/`** — 10-step smoke for the
  public `/facilitator/*` surface against a mocked gateway. Covers
  supported / health / verify (Cosmos + EVM) / settle (Cosmos) /
  settle without auth / settle with bad auth / rate limit /
  idempotency.

### Verified

- **Real Solana devnet settlement through MCP**: agent → MCP →
  402 → MCP signs SPL `transferChecked` with CU limit 20_000 (the
  cap PayAI enforces; the previous default of 200_000 was rejected)
  → mock x402 forwards `PAYMENT-SIGNATURE` to PayAI `/settle` →
  PayAI co-signs and broadcasts to Solana devnet → real
  `txSignature` returned to the agent. Tx queryable on
  `https://explorer.solana.com/tx/<sig>?cluster=devnet`.
- **Real Cosmos settlement** (regression — unchanged from v0.2.0):
  `MsgExec(MsgSend)` on Noble grand-1 still passes the `mcp-real`
  suite end-to-end.
- **Idempotent replay on Solana**: a second `pay_and_call` with the
  same `(payer, network, url, body, hourBucket)` returns
  `idempotentReplay: true` with the same `paymentId` and
  `txSignature` — no second on-chain transaction.
- **All 6 smoke suites green**: `mocked` (10), `real` (9),
  `mcp-mocked` (7), `mcp-real` (4), `facilitator-mocked` (10),
  `mcp-solana` (5).

### Deferred

- **Coinbase CDP real-network smoke** remains gated on a CDP API
  key. Static config + adapter unit tests cover the wire format;
  real settle awaits credentials.
- **PayAI mainnet smoke** — devnet is the only on-chain smoke that
  runs by default. Mainnet costs real money and is captured as
  IDEAS.md entry 8 for future scheduled runs.
- **Self-serve resource-key issuance** for the public
  `/facilitator/*` surface — keys are admin-bootstrapped today
  (IDEAS.md entries 9, 10).

## [v0.2.0] — 2026-05-27

Phase 2 stable. MCP server with multi-network signing and verified
real on-chain payment through the agent flow.

### Added

- **MCP server** at `apps/mcp` exposing the suverse-pay x402 gateway
  to AI agents over the Model Context Protocol streamable-HTTP
  transport. Seven tools: `init_session`, `list_providers`,
  `discover_endpoints`, `get_quote`, `pay_and_call`,
  `get_payment_status`, `end_session`.
- **Zero-custody session management**: signing secrets held in
  per-process `Buffer` only, zeroed on `Session.destroy()`, never
  logged (pino `redact` list), never persisted, never transmitted.
  Idle sessions are swept every 60s.
- **TypeScript signing packages**:
  - `@suverse-pay/signer-cosmos` — ADR-036 `PaymentPayload` signing
    for the `exact_cosmos_authz` scheme on `cosmos:grand-1`.
    Byte-compatible with the cosmos-pay Go reference fixture.
  - `@suverse-pay/signer-evm` — EIP-3009 `transferWithAuthorization`
    signing for the `exact` scheme on Base, Polygon, and Arbitrum
    (USDC + Base EURC). Round-trip self-consistency verified via
    `recoverTypedDataAddress` for every `(network, token)` pair.
- **Discovery aggregator** `@suverse-pay/discovery` combining
  Coinbase Bazaar (live `GET /v2/x402/discovery/search`) and a
  cosmos catalog placeholder. Dedup by `(resource, network, asset)`
  tuple so the same URL with multiple payment options is preserved
  as separate entries.
- **MCP-side idempotency cache** keyed by
  `sha256(payerAddress | network | url | sha256(body) | hourBucket)`.
  A replay of the same call within the same wall-clock hour returns
  the cached result without re-signing or re-submitting; the cache
  key explicitly excludes `sessionId` so a fresh MCP session for the
  same wallet still dedupes.
- **Smoke suites**:
  - `scripts/smoke/mcp-mocked/` (7 steps) drives the MCP HTTP
    transport against a mock x402 endpoint + mock gateway with the
    real signers in the loop.
  - `scripts/smoke/mcp-real/` (4 steps) reuses
    `/home/govhub/x402-cosmos/examples/server` as the paid endpoint
    and broadcasts a real `MsgExec(MsgSend)` on Noble testnet
    `grand-1` through the MCP `pay_and_call` flow.
- Comprehensive `apps/mcp/README.md` with tool reference, env vars,
  Claude Desktop / Cursor config, and architecture diagram.

### Verified

- **End-to-end MCP pay-and-call on a live chain**: agent → MCP →
  402 → ADR-036 sign → POST `PAYMENT-SIGNATURE` → cosmos-pay
  facilitator → on-chain `MsgExec(MsgSend)` on Noble `grand-1` →
  retry response. Real `txHash` returned to the agent in the same
  tool result.
- **Idempotency on-chain proof**: two `pay_and_call` invocations
  with the same `(sessionId, url, body)` within an hour return the
  same `paymentId` and `txHash` with `idempotentReplay: true`; the
  mock x402 server's call counter shows exactly one paid request
  (no second on-chain broadcast).
- **Cosmos signer byte-compatible** with the cosmos-pay Go fixture:
  direct `/verify` against the live facilitator returns
  `isValid: true` for the TS-signed payload.
- **EVM signing** self-consistent via `recoverTypedDataAddress`
  round-trip for every trusted `(network, token)` pair.
- **Zero-custody assertion**: the canonical BIP-39 test mnemonic
  word "abandon" never appears in any surfaced error message
  across the 40-test MCP suite.
- **x402 wire-format dual-mode**: `pay_and_call` parses 402
  responses from both the v2 spec `PAYMENT-REQUIRED` header
  (base64 `{accepts: [...]}` envelope) AND the cosmos-pay
  middleware flat shape (`{scheme, network, asset, ...}` directly).
  Outbound `PAYMENT-SIGNATURE` is written in the cosmos-pay /
  x402-py compatible flat shape with `scheme` and `network` at the
  top level.
- All four smoke suites green: `mocked` (10/10), `real` (9/9),
  `mcp-mocked` (7/7), `mcp-real` (4/4).

### Deferred to v0.3+

- **EVM real-network smoke** (requires a Coinbase CDP API key).
  EVM signing math is verified offline today.
- **Solana signing and adapter** — leading Phase 3 candidate given
  Solana's share of live x402 volume. See `IDEAS.md` item 4.
- **PayAI adapter** as a third facilitator across cosmos-pay /
  Coinbase CDP. See `IDEAS.md` item 5.
- **Permit2 fallback** for ERC-20s that don't implement EIP-3009
  (e.g., USDT, DAI).
- **Cosmos mainnet** (`cosmos:noble-1`) — requires a funded
  mainnet facilitator.
- **Stdio MCP transport** — only streamable HTTP is wired up.
- **Resource-server facilitator mode** — let an x402 middleware
  configure suverse-pay as its facilitator URL. See `IDEAS.md`
  item 6 for the architectural sketch.

## [v0.1.0] — 2026-05-27

Phase 1 stable. Real-network smoke gate is green.

### Added

- `scripts/smoke/real/` — 9-step end-to-end suite that exercises the
  gateway against a live `cosmos-pay` facilitator on Cosmos testnet
  `grand-1`. Each `05-settle.sh` run broadcasts a real
  `MsgExec(MsgSend)` and asserts the on-chain `txHash` round-trips
  through `/settle` and `/payments/:id`.
- Fixture generator at `x402-cosmos/tools/fixture/` produces a fresh
  ADR-036-signed `PaymentPayload` + matching `PaymentRequirements`
  per invocation. Cross-repo, referenced over HTTP; no vendored Go
  code lands in this TypeScript monorepo.

### Verified

- Idempotency invariant under real on-chain conditions: a duplicate
  `/settle` with the same `Idempotency-Key` returns the same
  `paymentId` and the same on-chain `txHash`, and `/payments/:id`
  reports exactly one attempt (no second broadcast).
- `cosmos-pay` HTTP integration via real `/verify` and `/settle`.
  `/providers` reports `cosmos-pay` healthy when the facilitator is
  reachable, and runtime capability discovery correctly supersedes
  the adapter's static mainnet capability with the testnet one
  the facilitator actually offers.

### Deferred to v0.2+

- Coinbase CDP real-network smoke (requires CDP API key).
- Cross-provider fallback under real conditions (requires a second
  reachable facilitator).
- Race-replay terminal state polish (see "Known limitations" in
  README — duplicate `/settle` may transiently surface as `pending`).
- SIGHUP-style admin api_key rotation without server restart.

## [v0.1.0-rc.1] — 2026-05-26

Phase 1 release candidate. All mocked Phase-1-done acceptance
criteria from TASK.md §"Required for Phase 1 done" are green:

- `pnpm install && pnpm build` exits 0 (7 packages).
- `pnpm test` exits 0 (284 unit tests, 1 documented skip).
- `pnpm test:integration` exits 0 (25 end-to-end tests against the
  live Docker Postgres + Redis with nock-intercepted provider HTTP).
- `docker compose up -d && pnpm db:migrate && pnpm db:bootstrap`
  applies the schema and seeds the admin api_key end-to-end against
  Postgres 15.
- `bash scripts/smoke/mocked/run-all.sh` PASSes all 10 endpoint
  scenarios from TASK.md §"Required for Phase 1 done" item 4, plus a
  bonus `/verify` step.
- README has a copy-paste runnable quick start (clone → docker compose
  → migrate → bootstrap → smoke).

### Known limitations carried into Phase 2

- Race-replay of `/settle` may surface a payment in `pending` state.
  Exactly one row and one adapter HTTP call still happen (verified by
  the integration `Promise.all` test); clients should `GET
  /payments/:id` to see the terminal state. Phase 2 will hold the
  Redis lock through finalization.
- `pnpm db:bootstrap --force` rotation updates the on-disk hash; the
  running server keeps the prior hash in memory until restart.
  Documented in README; Phase 2 will add SIGHUP-style rotation.
- One vitest case (`services/orchestrator/src/health-check.test.ts:177`)
  is `it.skip`ped because the 175ms wait + 50ms tick assertion is
  flaky under parallel test load. Phase 2 will rewrite with
  `vi.useFakeTimers()`.

### Release gate (NOT in this RC)

- Real-network smoke against a deployed `cosmos-pay` Cosmos testnet
  facilitator.
- Real-network smoke against Coinbase CDP x402 with a real API key.

Both are documented in TASK.md §"Required for v0.1.0 release tag".
The full `v0.1.0` tag depends on at least item #7 (cosmos-pay
testnet) passing.

## [Unreleased]

### Added

- Initial monorepo scaffolding: pnpm workspaces, Turborepo, shared
  `tsconfig.base.json`, Docker Compose for Postgres 15 + Redis 7,
  GitHub Actions CI skeleton, Apache 2.0 license, `.env.example`.
- `@suverse-pay/core-types` package — `ProviderAdapter` interface,
  CAIP-2 helpers, normalized error codes (with retryable/non-retryable
  classification per TASK.md), x402 protocol types
  (`PaymentRequirements`, `PaymentPayload`), gateway-internal
  `Payment` and `PaymentAttempt` types, `MerchantPolicy` schema,
  and Zod schemas for every adapter and gateway boundary type.
  `SettleOptions` carries an optional `idempotencyKey` that the
  orchestrator plumbs through to adapters for downstream replay
  protection.
- `@suverse-pay/provider-sdk` package — `BaseAdapter` abstract class,
  `httpJson` fetch wrapper, `withRetry` (retryable codes only),
  `withTimeout`. `httpJson` propagates the caller's `Idempotency-Key`
  on every retry attempt, satisfying the two-layer idempotency
  invariant end-to-end.
- `ProviderAdapter.getStatus()` now accepts an optional `hints`
  argument (`{ txHash?, errorCode? }`). Adapters for providers with
  no native status endpoint (cosmos-pay) reconstruct status from the
  orchestrator-supplied hints rather than taking a DB dependency.
- `@suverse-pay/adapter-cosmos-pay` package — first concrete adapter.
  Wraps `sudzikcoin/cosmos-pay`'s HTTP facilitator (`/verify`,
  `/settle`, `/supported`, `/healthz`). Wire schemas pinned to the
  real Go code (`facilitator/types.go` and `cmd/main.go`). Internal
  retry on `/settle` is enabled ONLY when the caller supplies an
  `idempotencyKey`. cosmos-pay's `invalidReason` / `errorReason`
  strings are normalized through a dictionary-style map with a
  warning-logged `provider_internal_error` fallback for unknown
  codes. `/healthz` uses raw `fetch` (empty body, no JSON parse).
- `@suverse-pay/adapter-coinbase-cdp` package — second concrete
  adapter. Wraps Coinbase Developer Platform's hosted x402 facilitator
  at `https://api.cdp.coinbase.com/platform/v2/x402` (EVM + Solana,
  `exact` / `upto` schemes). Wire shapes pinned to the canonical
  x402 v2 reference types in `coinbase/x402` on GitHub.
  Authentication is a short-lived EdDSA JWT (`jose` + Ed25519) built
  per the CDP spec (sub/iss=cdp/aud=[cdp_service]/nbf/exp/uri, header
  with random nonce). `UsageTracker` interface + `InMemoryUsageTracker`
  enforce the configurable monthly hard cap from `supports()` so
  routing skips this provider once the free tier is exhausted — a
  Redis-backed tracker will plug in during Step 6.
- `.env.example` updated: `COINBASE_CDP_API_KEY` /
  `COINBASE_CDP_API_SECRET` renamed to `COINBASE_CDP_API_KEY_NAME` /
  `COINBASE_CDP_API_KEY_SECRET` to match the CDP portal's exported
  terminology. Optional `COINBASE_CDP_BASE_URL` added.
- vitest test runner (workspace devDep). 156 unit tests across all
  four packages.
- `@suverse-pay/orchestrator` service — the brain of the gateway.
  Pure-logic modules (`router`, `policy`, `quote-aggregator`,
  `fallback`) and IO-bound modules (`PaymentLedger`, `ProviderRegistry`,
  `CapabilityDiscoveryCron`, `HealthCheckCron`, `RedisUsageTracker`)
  are split so the bulk of routing semantics is testable without a
  database.
  - Router implements TASK.md §"Routing logic v0.1" exactly:
    supports-filter → live-traffic-health-rule (>=10 attempts &
    >=30% failures => unhealthy) → quiet-period fallback to
    `provider_health_checks` (5min window) → score by
    cost/latency/success_rate → optional provider-hint promotion
    (silently ignored if the hint fails support or health filters).
  - PaymentLedger enforces two-layer idempotency: Postgres unique
    partial index on `(api_key_id, idempotency_key)` is authoritative;
    Redis SETNX lock is the fast-path that avoids racing duplicate
    `/settle` calls into the unique-violation path. Verified by a
    `Promise.all` race test that fires 10 concurrent requests with
    the same key and asserts exactly one INSERT.
  - FallbackManager writes a `payment_attempts` row BEFORE every
    network call (CLAUDE.md invariant 4); cross-provider retry runs
    only on retryable error codes and only against candidates that
    still pass `supports()` at attempt time.
  - CapabilityDiscoveryCron + HealthCheckCron use `setInterval` for
    v0.1 (no BullMQ until we need real durability). Discovery
    reconciles static vs. discovered rows, marking superseded
    capabilities; an empty discovery result is treated as transient
    and does NOT supersede any static rows.
  - RedisUsageTracker implements the `UsageTracker` interface that
    `@suverse-pay/adapter-coinbase-cdp` defined in Step 5. Buckets
    per UTC month, auto-expires the key 35 days out (no monthly cron
    needed).
  - Tests use `pg-mem` + `ioredis-mock` for IO-bound modules; pure
    logic has no DB dependency. 83 new tests, 239 total across the
    workspace.
- `@suverse-pay/db` — SQL migrations and a ~100-line raw-SQL runner.
  No `node-pg-migrate` / Knex / Prisma dep — `pnpm db:migrate` is a
  single `tsx src/migrate.ts` invocation that reads every `.sql` file
  in `db/migrations/` in lexicographic order, applies the ones not
  yet recorded in `schema_migrations`, and wraps each one in its own
  transaction so partial application is impossible. Bootstraps
  `schema_migrations` itself outside any transaction with
  `IF NOT EXISTS`, so the runner is safe against an empty DB or one
  that has been partially migrated.
  - `001_initial.sql` creates the Phase 1 schema verbatim from
    TASK.md §"Database schema (Postgres)": `api_keys`,
    `merchant_policies`, `providers`, `provider_capabilities`
    (with `is_static` / `is_discovered` / `superseded_at`),
    `provider_health_checks`, `payments` (with the partial unique
    index on `(api_key_id, idempotency_key) WHERE idempotency_key
    IS NOT NULL` that the orchestrator's two-layer idempotency
    relies on), `payment_attempts`, and `routing_decisions`. Every
    statement uses `IF NOT EXISTS` so a re-run on an already-
    migrated DB is a no-op.
  - `db/schema.sql` — consolidated reference snapshot of the full
    schema. NOT executed; the migrations are the source of truth.
    Useful for IDE schema tooling and drift diffs against a live DB.
    A vitest assertion compares `CREATE TABLE` statements in the
    migrations against the snapshot, so an out-of-date snapshot
    fails CI before review.
  - `docker-compose.yml` host port defaults moved from 5432 / 6379 to
    5433 / 6380, and the `.env.example` `DATABASE_URL` / `REDIS_URL`
    were rewritten in lockstep — the gateway intentionally avoids
    the canonical Postgres / Redis ports so it can run alongside an
    existing host-level Postgres (e.g. the govhub deployment on the
    same VM) without a manual override.
  - 5 vitest cases against `pg-mem`: applies-on-first-run,
    creates-canonical-tables, idempotent-second-run, rolls-back-on-
    failure (with an explicit comment on a `pg-mem` gotcha — it does
    not roll back DDL inside a transaction, so the assertion is the
    data-level `schema_migrations` row absence, not the DDL absence;
    real Postgres rollback verified at Step 10), and the schema.sql-
    matches-migrations sentinel.
  - pg-mem gotcha #2: pg-mem does not implement `to_regclass()`. The
    test for "table exists" uses `information_schema.tables`, which
    works in both pg-mem and real Postgres.
  - Verified against the real Docker stack (Postgres 15-alpine on
    port 5433, Redis 7-alpine on port 6380). `pnpm db:migrate` on
    a fresh DB applied `001_initial.sql` and produced exactly the
    9 expected tables (8 project + `schema_migrations`). A second
    invocation was a no-op (`= 001_initial.sql (already applied)`).
    `payments_idempotency_idx` is a unique btree with the
    `WHERE (idempotency_key IS NOT NULL)` predicate; the
    `provider_capabilities` CHECK constraint
    `(is_static OR is_discovered)` is present. A failing
    out-of-tree migration was rolled back fully — both the
    `schema_migrations` row AND the partially-created table, which
    is the real-Postgres behaviour that pg-mem cannot model.
- `scripts/smoke/mocked/` — curl-based mocked smoke suite, one shell
  script per endpoint. Drives the live Postgres + Redis but registers
  in-memory `ProviderAdapter` fakes via a separate Fastify entrypoint
  (`apps/api/src/server-mock.ts`) so the production codepath has zero
  conditional "test mode" branches.
  - 10 numbered steps mapped to every TASK.md §"Required for Phase 1
    done" item 4 scenario plus a `POST /verify` bonus. `run-all.sh`
    orchestrates the whole sequence and always tears down the
    background server even on failure.
  - `_lib.sh` provides shared coloured PASS/FAIL output, an
    `expect_status` curl helper, and a `stop_smoke_server` routine
    that cascades SIGTERM → port-free wait → SIGKILL through the
    pnpm→tsx→node parent chain (since a naive `kill <pnpm pid>`
    leaves the listening Node child running and the port busy).
  - `SMOKE_COSMOS_PAY_FAIL_MODE` env knob restarts the mock server
    with cosmos-pay always returning a chosen `ErrorCode`. Step 07
    uses it to exercise the failure + retryable path end-to-end, then
    re-starts the server in default mode for downstream steps.
  - Default port is 3333 (not 3000 to stay clear of `pnpm dev`; not
    3001 because a host LaunchLoop instance was bound there). Every
    knob — `API_PORT`, `ADMIN_API_KEY`, `DATABASE_URL`, `REDIS_URL`,
    latency injection — is overridable via env.
  - Verified twice in a row that `run-all.sh` is idempotent — second
    run from a non-clean DB still PASSes 10/10 because step 00
    TRUNCATEs and re-bootstraps.
- `apps/api/tests/integration/` — full end-to-end integration suite
  driven against the live `docker compose` Postgres 15 + Redis 7 stack.
  Adapter HTTP traffic is intercepted by `nock` so the real cosmos-pay
  / Coinbase CDP wire shape (JWT signing, error mapping, retry path)
  is exercised without any external network. 25 tests across 8 files:
  - `setup.ts` builds the full Fastify app against the real Pool /
    Redis / Ledger / Registry, registers cosmos-pay + a Coinbase CDP
    adapter pointed at nock-able mock hosts, and exposes a
    `cleanState(stack)` helper that TRUNCATEs every non-fixture table,
    `FLUSHDB`s Redis, and re-bootstraps the admin api_key — so every
    test starts from a known-clean state.
  - Every required scenario from TASK.md §"Required for Phase 1 done"
    item 4 is covered:
    1. `GET /health` → 200 (no auth).
    2. `GET /providers` → both adapters listed with their static caps.
    3. `POST /quote` → synthetic quotes returned, both adapters
       considered.
    4. `POST /quote` with `optimize=cost` → quotes ordered ascending
       by `estimatedFeeUsd`.
    5. `POST /settle` against the cosmos-pay mock → `payments`,
       `payment_attempts`, and `routing_decisions` rows all populated;
       response carries the mock tx hash.
    6. Same `POST /settle` with the same `Idempotency-Key` → same
       paymentId, no second adapter HTTP call (verified by
       `nock.isDone()`), exactly one row in `payments`.
    7. `POST /settle` simulating provider failure → retryable path
       exercised end-to-end through `httpJson`'s retry logic
       (cross-provider fallback itself remains covered by the unit
       suite in `apps/api/src/__tests__/settle.test.ts`, since the
       integration fixture only registers one provider per route).
    8. `POST /settle` with an unsupported scheme → fails immediately
       with `route_unsupported`, zero adapter calls, attempts list
       empty.
    9. `GET /payments/:id` → returns the payment with its attempts
       array after a `/settle`.
    10. `GET /metrics/summary` → aggregate totals + per-provider
        breakdown.
  - Auth coverage: missing header → 401, wrong key → 401, valid key
    → 200, `db:bootstrap --force` rotation does NOT invalidate the
    running server's in-memory hash (documented behaviour — rotation
    requires a server restart in v0.1).
  - Idempotency: `POST /settle` without `Idempotency-Key` → 400 with
    `invalid_request` and no payment row created.
  - **Real `Promise.all` race**: two concurrent `POST /settle` with
    the same key return the same `paymentId`, exactly one outbound
    adapter call (nock `isDone()`), exactly one `payments` row. The
    final state is `settled` with the mock tx hash, verified via a
    follow-up `GET /payments/:id`. A v0.1 race-replay limitation is
    surfaced and documented in-test: the replay request may observe
    the row while still `pending`; v0.2 will hold the lock until
    finalization.
- `apps/api` test split: `pnpm test` now drives the in-memory unit
  suite via `vitest.config.ts`; `pnpm test:integration` drives the
  Docker-backed suite via `vitest.integration.config.ts`. Root
  `pnpm test` runs unit only (so it stays green without Postgres);
  `pnpm test:integration` is a separate workspace script.
- `.github/workflows/ci.yml` split into two jobs: `unit` (build +
  unit tests, no services) and `integration` (Postgres 15 + Redis 7
  as GitHub Actions services, `db:migrate`, `db:bootstrap`,
  `test:integration`).
- `pnpm db:bootstrap` — CLI that seeds the single
  `apikey_admin_default` row in `api_keys` from the `ADMIN_API_KEY`
  env var. Sha256 hash only — never the plaintext. Idempotent by
  default; a mismatched existing row refuses to overwrite unless
  `--force` (or `ADMIN_API_KEY_FORCE=1`) is supplied, so an
  accidental env-var typo cannot lock everyone out of the gateway.
  - The hash function (`sha256ApiKeyHash`) and the row id
    (`ADMIN_API_KEY_ID = 'apikey_admin_default'`) now live in
    `@suverse-pay/db` and are re-exported by
    `apps/api/src/plugins/auth.ts`. The write side (bootstrap CLI)
    and the read side (Fastify auth plugin) therefore share one
    source of truth — they cannot drift apart.
  - The `db` package was reorganised: `migrate.ts` now exports only
    the pure runner; CLI shells live in `migrate-cli.ts` and
    `bootstrap-cli.ts`; a new `index.ts` re-exports the public API.
  - 8 vitest cases against `pg-mem` cover the matrix: fresh insert,
    same-key replay (skipped), mismatched-key (rejected with a
    typed `AdminKeyRotationRequiredError`), rotation under
    `force=true`, empty-key rejection, plus three sha256 sanity
    checks including an `openssl dgst -sha256` cross-check against
    a known vector. README now documents the bootstrap step + the
    rotation flow.
  - Verified end-to-end against the live Docker Postgres on port
    5433: created → skipped → refused → rotated → missing-env all
    return the expected exit codes, and a direct
    `psql ... key_hash` query matches the `sha256sum` of the
    plaintext bit-for-bit (proving the server will accept the same
    key the bootstrap wrote).
- `@suverse-pay/api` — Fastify HTTP entrypoint for the gateway. One
  endpoint per TASK.md §"REST API specification": `GET /health`
  (liveness, unauthenticated), `GET /providers`, `POST /quote`,
  `POST /verify`, `POST /settle`, `GET /payments/:id`,
  `GET /metrics/summary`. Plugins: sha256 admin-key bearer auth (Phase
  4 will keep `request.apiKeyId` shape but resolve it from DB),
  Idempotency-Key extraction, Redis-backed `@fastify/rate-limit`
  (in-memory fallback when no Redis), pino structured logging, and a
  global error handler that normalizes Zod / GatewayError /
  ProviderError / Fastify errors into a single `{ error: { code,
  message } }` envelope.
  - Architectural split: `buildServer(ctx)` takes a `ServerContext`
    with `registry`, `ledger`, `loadHealthSummaries`, `loadMetrics`,
    so every route is testable with in-memory fakes. The real Pool /
    Redis / cron / adapter wiring is confined to `index.ts`. Tests
    never touch real Postgres.
  - `/settle` is the hot path: it asserts the Idempotency-Key header
    (400 otherwise), calls `PaymentLedger.createOrFetchPayment` (two-
    layer idempotency — Postgres unique index + Redis SETNX lock),
    runs the router, persists the decision to `routing_decisions`,
    drives `runFallback` across the candidate list, finalizes the
    `payments` row, and always releases the Redis lock in a
    `finally` block.
  - `/payments/:id` returns 404 (not 403) for cross-tenant lookups,
    so an api key cannot probe for the existence of another tenant's
    payment.
  - Graceful shutdown on SIGTERM / SIGINT stops both crons, closes
    the Fastify server, ends the pg pool, and disconnects Redis.
  - `loadHealthSummariesFromDb` rolls up `payment_attempts` (last
    60s + 7d) and the most recent `provider_health_checks` row per
    provider for the router's health-rule input. `loadMetricsFromDb`
    powers `/metrics/summary` with payment status counts + per-
    provider attempt/success/failure rolls over the last 24h.
  - 33 integration tests using `app.inject()` — auth (5), `/health`
    (2), `/providers` (3), `/quote` (5), `/verify` (5), `/settle` (8
    incl. idempotency replay, fallback chain, non-retryable stop,
    route_unsupported, and Redis-lock release on exception),
    `/payments/:id` (3), `/metrics/summary` (2). Total workspace
    coverage now 272 tests across 30 files.
