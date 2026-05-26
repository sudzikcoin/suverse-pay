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
- vitest test runner (workspace devDep). 33 unit tests covering
  CAIP-2 parsing, error classification, and schema parsing.
