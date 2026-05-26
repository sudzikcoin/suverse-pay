# Changelog

All notable changes to `suverse-pay` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/).

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
