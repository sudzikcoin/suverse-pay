# KICKOFF.md — paste this into Claude Code

Copy the message between the `---` lines as your first message in a
fresh Claude Code session, after `cd`-ing into the empty `suverse-pay`
directory containing this file along with `CLAUDE.md` and `TASK.md`.

---

You're starting a new TypeScript monorepo called **suverse-pay** — a
unified payment gateway for the x402 protocol. It abstracts multiple
x402 facilitator providers (Coinbase CDP and our own cosmos-pay)
behind a single REST API.

Before writing any code, read these three files in order:

1. `CLAUDE.md` — architecture, conventions, invariants. Binding.
2. `TASK.md` — concrete Phase 1 brief: API spec, DB schema, routing
   logic, adapter contracts, monorepo structure, acceptance criteria.
3. `https://github.com/sudzikcoin/cosmos-pay` — the sister repo whose
   HTTP API we wrap as one of the two adapters. Read the README and
   `specs/scheme_exact_cosmos_authz.md`.

Then implement Phase 1 per `TASK.md` §"Implementation order", steps
1 through 12.

After each step, run `pnpm build` and any relevant tests. Do not
proceed to the next step on a red build.

When you reach step 5 (Coinbase CDP adapter integration tests), stop
and ask me for a Coinbase Developer Platform API key. Until I provide
one, stub the adapter with mocks and continue with the rest.

You have full permission to install deps, scaffold tooling, run
migrations, commit, push, and refactor within the prescribed
structure. Do not ask permission for routine work. Do ask if you hit
a genuine ambiguity in the spec.

When Phase 1 acceptance criteria pass (see `TASK.md`), report back
with: build status, test results, smoke test output, and a list of
any deviations from the spec.

---

## After Claude Code starts

It will start with monorepo scaffolding (pnpm workspaces, Turbo,
tsconfig, Docker compose for Postgres + Redis). Then `core-types`,
then adapters, then orchestrator, then the API.

Estimated time to v0.1 with Claude Code working autonomously: 2-3
weeks of focused sessions.

## Things you'll need to provide along the way

When Claude Code asks:

1. **Coinbase CDP API key + secret**. Sign up at
   <https://portal.cdp.coinbase.com/>, create a project, generate an
   x402 facilitator API key. Free tier covers 1000 settlements/month
   which is plenty for v0.1 testing. The exact env var names are
   adapter-internal (`COINBASE_CDP_*`); the adapter conforms to
   whatever auth scheme CDP currently requires.

2. **cosmos-pay deployment URL**. Easiest option: run cosmos-pay
   locally on the same VPS, point `COSMOS_PAY_BASE_URL` at
   `http://localhost:8402`. Long-term you'll want it on a separate
   subdomain like `cosmos-pay.suverse.dev`. Either works for v0.1.

3. **Postgres + Redis credentials**. `docker-compose up -d` brings
   them up locally with default credentials. For production you'll
   set `DATABASE_URL` and `REDIS_URL` to managed services. Not
   blocking v0.1.

## Common failure modes to watch for

If Claude Code reports anything below, address before continuing:

- **Idempotency tests failing.** This is critical — duplicate
  `/settle` calls with the same key MUST NOT trigger a second
  on-chain transaction or a second provider call. If tests fail
  here, do not push.

- **Routing chooses unhealthy provider.** Check the health-window
  logic — providers should be excluded after >=30% failures in 60
  seconds with at least 10 attempts in the window. Low-traffic
  windows fall back to `provider_health_checks` recent status.

- **Fallback tries unsupported provider.** Check that fallback only
  considers candidates that satisfy `supports(network, asset, scheme)`
  for the exact route. There should be no "try any other provider"
  fallback.

- **Adapter leaks provider-specific shapes.** Search the codebase
  for `if (providerId === ...)` outside `packages/adapters/`. If
  found, refactor.

- **Coinbase quota exceeded in dev.** The adapter has a hard cap
  configurable via `COINBASE_CDP_MONTHLY_HARD_CAP` (default 5000).
  If exceeded, the adapter starts returning `quota_exceeded` from
  `supports()`. Raise the cap or wait until next month.

## Repo conventions

- License: Apache 2.0 (same as cosmos-pay).
- Commits: conventional commits (`feat:`, `fix:`, `chore:`, etc).
- Branch protection: enforce on `main` once team grows.
