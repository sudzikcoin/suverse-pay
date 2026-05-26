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
- vitest test runner (workspace devDep). 71 unit tests across both
  packages (CAIP-2, error classification, schema parsing, retry
  semantics, timeout semantics, full HTTP-error → ErrorCode mapping,
  and Idempotency-Key propagation under retry).
