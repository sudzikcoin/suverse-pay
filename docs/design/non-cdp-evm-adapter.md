# Design — non-CDP EVM facilitator adapter

Status: **DESIGN ONLY**, not implementation. Spawned out of Phase 4
Block 1 Sub-task 1 when probing `/supported` showed CDP advertises
no EVM networks beyond Base / Polygon / Arbitrum / World Chain.
Targets that matter (Optimism, Avalanche, BNB Chain) are reachable
via *other* x402 facilitators today; this doc proposes which one to
adopt as our next adapter and what the implementation scope is.

## Problem

Networks that real applications ask for, by rough order of x402
volume and request frequency:

1. **Optimism** (eip155:10). Live USDC, mature L2, plenty of
   wallets. Not in CDP.
2. **BNB Chain** (eip155:56). High volume but the USDC there isn't
   the dominant stablecoin — USDT and USD1 are. Binance launched
   their own x402 facilitator covering both.
3. **Avalanche C-Chain** (eip155:43114). Solid USDC presence.
   Thirdweb/PayAI/Ultravioleta DAO all run x402 facilitators on it.

CDP isn't going to cover all of these on our timeline. We need a
second EVM facilitator adapter that wraps one (or more) of the
public x402 facilitator services.

## Candidates

### A. Thirdweb x402 facilitator
- URL: `https://x402.thirdweb.com` (per their docs).
- Networks: every major EVM L1/L2 the Thirdweb stack covers —
  Ethereum, Optimism, Polygon, Arbitrum, Avalanche, BSC, Base,
  Linea, Scroll, Blast, Mantle, …
- Schemes: `exact` (EIP-3009) + `permit2-exact` + `permit2-upto`.
  Permit2 unlocks tokens that don't natively implement EIP-3009
  (USDT, DAI, …).
- Auth: per-API-key Bearer; free tier exists.
- Wire shape: vanilla x402 v2 — uses spec's `maxAmountRequired`,
  no envelope translation needed (unlike CDP). Reuses our existing
  `PaymentPayloadSchema` and `PaymentRequirementsSchema` verbatim.
- Failure modes: standard `{isValid, invalidReason, ...}` body on
  /verify; on settle returns x402 v2 `SettleResponse`.

### B. Binance x402 facilitator
- URL: `https://x402.binance.com` (per docs / blog).
- Networks: **BNB Chain only** (eip155:56). Possibly eip155:97
  testnet.
- Schemes: `exact` (EIP-3009 for USDC), `permit2-exact`,
  `permit2-upto` (for USDT, USD1).
- Auth: API key (Binance dev portal).
- Wire shape: standard x402 v2 per their announcement.
- Failure modes: TBD — likely standard but should probe.

### C. PayAI EVM
- We already wrap PayAI for Solana
  (`@suverse-pay/adapter-payai`). PayAI's /supported also lists
  EVM networks (Polygon, Arbitrum, Avalanche, Sei, Sonic, etc.)
  but for v0.3.0 we deliberately did NOT route EVM traffic to
  PayAI — CHANGELOG entry: *"PayAI also covers EVM but is
  intentionally NOT advertised here for v0.3.0 — until we have
  real-network data showing PayAI is a sensible EVM backup, it
  stays Solana-only in routing."*
- **Lowest-effort path**: flip a routing-config line, no new
  adapter, no new auth flow. Adapter already exists.

## Recommendation

**Phase 4 Block 1 Sub-task 2: route EVM failover through PayAI**
(option C) — minimum-viable, zero new code beyond routing config
+ real smoke on one PayAI-only EVM network.

**Phase 4 Block 1 Sub-task 3 (separate, larger): Thirdweb adapter**
(option A) — gives us Optimism + Avalanche + every other major
EVM L1/L2 with one integration. Same EIP-3009 path our existing
`signer-evm` produces; Permit2 stays deferred.

**Binance adapter (option B)** — defer. Single-network adapter
(BNB only) doesn't justify a new auth surface yet. Revisit when
USDT-on-BNB demand materializes.

Rationale: Thirdweb is the best return on effort. One adapter,
~10 EVM networks added, vanilla x402 wire shape (no envelope
quirks à la CDP), and a Permit2 path opens later. PayAI EVM
failover is free and worth doing first as a stress test of the
multi-adapter routing the gateway already has.

## Implementation scope — Thirdweb adapter

If we go with Thirdweb (recommended), new work is roughly:

1. **New package**: `packages/adapters/thirdweb-x402/`
   - `adapter.ts` — implements `ProviderAdapter`. Reuses
     `BaseAdapter`, `httpJson`, `withRetry` from
     `@suverse-pay/provider-sdk`. The verify/settle bodies are
     vanilla x402 v2 so `toThirdwebRequest` is literally
     `(req) => ({x402Version: 2, paymentPayload: req.paymentPayload,
     paymentRequirements: req.paymentRequirements})`. No envelope
     translation à la CDP.
   - `wire.ts` — Zod schemas for Thirdweb's /supported, /verify,
     /settle responses.
   - `adapter.test.ts` — mocked unit tests (same shape as
     `coinbase-cdp`'s 58-test suite).
2. **Auth**: `THIRDWEB_X402_API_KEY` env var. Single Bearer key,
   no JWT. Simpler than CDP.
3. **Capabilities** (`apps/api/src/index.ts`): register the
   adapter with the per-(network, asset, scheme) tuples Thirdweb
   advertises. Same `cdpCaps`-style declaration.
4. **Signer updates** (`packages/signers/evm/src/domains.ts`):
   add trusted EIP-712 domains for USDC on the new networks
   (Optimism, Avalanche, etc.). Each entry probed on-chain for
   `name()` / `version()` exactly as we did for Base Sepolia and
   World Chain — never guess Circle's domain strings, the test
   deployments diverge from mainnet (`"USDC"` vs `"USD Coin"`).
5. **Facilitator routing** (`services/facilitator/src/routing-config.ts`):
   add `eip155:10:exact → [thirdweb-x402, ...]`, etc. For
   networks BOTH adapters cover (Base, Polygon, Arbitrum), keep
   CDP primary, Thirdweb failover.
6. **Real-network smoke**: parametrize the existing
   `scripts/smoke/real-evm/` suite — already supports
   `SMOKE_REVM_NETWORK` / `SMOKE_REVM_USDC` overrides. Pick one
   Thirdweb-only network (Optimism Sepolia probably) and run the
   full 7-step suite. Cost: ~$0.002 USDC + a few drops of native
   gas, same as Base Sepolia smoke.
7. **Permit2** (separate sub-task, optional). Implementing the
   Permit2 signing path in `@suverse-pay/signer-evm` unlocks
   non-EIP-3009 tokens (USDT, DAI) on every EVM network we cover.
   That's its own design.

Estimated effort (single Claude Code session, sequential):

- PayAI EVM failover (option C): **~1 hour** — routing config +
  one smoke run on a PayAI EVM network.
- Thirdweb adapter (option A) end-to-end: **~4–6 hours** —
  scaffolding + adapter + 50ish unit tests + register + signer
  domains + real smoke on one Thirdweb-only network. Comparable
  to the original CDP adapter Step 5 + the v0.3.1 real-evm work.
- Binance adapter (option B): same shape as Thirdweb, ~3 hours
  for just BNB — defer.

## Out of scope for this design

- Permit2 signing flow. Lives in its own design doc when we need
  it.
- Native facilitator (us as a Cosmos / EVM facilitator with our
  own keys + on-chain settlement). Already on the Phase 5 marker
  list in STATUS.md.
- Switching the CDP-only `coinbase-cdp` adapter to do anything
  beyond what it does today.
