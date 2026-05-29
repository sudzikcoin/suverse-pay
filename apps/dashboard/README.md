# @suverse-pay/dashboard

Customer-facing dashboard for the suverse-pay payment gateway.
Phase 5 Block 4 Sub-task 1.

Deployed at `https://suverse-pay.suverse.io` (DNS + OAuth setup
required before first sign-in works — see "First-time setup" below).

## What it shows

A signed-in customer sees four panels driven by their linked
resource API keys:

1. **Summary cards** — total settles, settled volume (USDC), success
   rate, distinct networks active. Period toggle (24h / 7d / 30d).
2. **Volume chart** — settled USDC by hour (24h) or by day (7d/30d).
   Recharts area chart with amber accent.
3. **Settles list** — last 50 settles. Filter pills (All / Settled /
   Failed). Auto-refresh every 30s. Tx hashes link to the relevant
   block explorer per chain (Etherscan, Tronscan, Mintscan, etc.).
4. **Network breakdown** — per-network table: settled count, failed
   count, settled volume, success-rate pill. Ordered by volume.

> **Note**: the original spec called this last panel "per-endpoint
> breakdown". `facilitator_payments` does not carry an
> `endpoint_path` column today, so we group by network — same shape,
> different grouping field. Phase 5 carry-over: extend the wire spec
> so resource servers attach `resource_path` on settle, then the
> panel becomes a true per-endpoint breakdown without changing the
> UI.

## Tech stack

- Next.js 15 (App Router) + React 19
- TypeScript strict
- Tailwind CSS + custom dark-mode-default token set (warm neutral
  base, single amber accent — deliberately not the purple-gradient
  AI cliché)
- shadcn-style primitive cards / buttons / inputs (vendored in
  `src/components/ui/`)
- NextAuth.js v5 — Google + GitHub providers, JWT session strategy
- Recharts — volume area chart
- TanStack Query — data fetching + window-focus refetch
- Postgres via `pg` — shared schema with `apps/api`

The aesthetic direction is **editorial financial dashboard**: tight
tabular columns, JetBrains Mono for figures, Inter Tight for body,
restrained use of saturated colour. Skeleton loaders never spin.
Dark mode is the default; the design is built around it.

## Database schema additions

`db/migrations/003_dashboard.sql` adds two tables:

```sql
CREATE TABLE dashboard_users (
  id UUID PRIMARY KEY,                -- app-generated via crypto.randomUUID
  email TEXT NOT NULL UNIQUE,
  oauth_provider TEXT NOT NULL CHECK (oauth_provider IN ('google', 'github')),
  oauth_provider_id TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (oauth_provider, oauth_provider_id)
);

CREATE TABLE dashboard_user_resource_keys (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE,
  resource_key_id TEXT NOT NULL REFERENCES resource_api_keys(id) ON DELETE CASCADE,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, resource_key_id)
);
```

`gen_random_uuid()` is intentionally NOT used — the db test suite
runs on pg-mem which doesn't ship that function. UUIDs are generated
in Node code (`crypto.randomUUID()`); real Postgres + pg-mem stay in
sync. Apply with `pnpm db:migrate` from the repo root.

## API surface (Route Handlers)

All endpoints under `apps/dashboard/src/app/api/`. Every read is
scoped to the user's set of linked resource keys; no cross-tenant
data ever surfaces.

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/stats?period=24h\|7d\|30d` | totalSettles, totalVolumeAtomic, successRate, activeNetworks, **totalFeeAtomic, totalNetAtomic** |
| GET | `/api/settles?limit=50&filter=all\|settled\|failed` | last N settles (each row includes `feeAmount`) |
| GET | `/api/endpoints?period=24h\|7d\|30d` | per-network breakdown |
| GET | `/api/volume-chart?period=24h\|7d\|30d` | time-bucketed volume points |
| POST | `/api/link-key` | `{resourceKey}` body — links an existing key to the OAuth user |
| GET | `/api/link-key` | the current user's linked keys + labels (legacy — prefer GET `/api/keys`) |
| POST | `/api/keys` | `{label}` body — self-serve creation. 201 with `{resourceKeyId, plaintext, label, createdAt}` exactly once |
| GET | `/api/keys` | linked keys with full metadata (label, createdAt, lastUsedAt, isActive) + rate-limit budget |
| DELETE | `/api/keys/:id` | soft-revoke (sets `is_active = false`). 404 for keys not linked to this user |
| GET | `/api/invoice[?from=YYYY-MM-DD&to=YYYY-MM-DD]` | CSV download — every settled row in `[from, to)` plus a summary header. Defaults to the previous completed UTC calendar month |
| **GET** | **`/api/webhooks`** | **list endpoints (signing secrets OMITTED)** |
| **POST** | **`/api/webhooks`** | **`{url, description?, events?}` body — creates endpoint, returns secret EXACTLY ONCE** |
| **DELETE** | **`/api/webhooks/:id`** | **hard delete (deliveries cascade)** |
| **GET** | **`/api/webhooks/:id/deliveries[?limit=50]`** | **recent delivery attempts** |
| **POST** | **`/api/webhooks/:id/deliveries/:dId/retry`** | **manual retry — resets row to pending + enqueues BullMQ job** |

All return 401 if there's no session. POST `/api/link-key` and
DELETE `/api/keys/:id` both return 404 on unknown / cross-tenant
references (generic — never confirms "key exists but is inactive"
vs "key not found").

## Self-serve key creation (Sub-task 2)

A signed-in user can mint a fresh resource API key from the
dashboard — no manual ops contact required. Two safeguards:

- **Hard cap**: up to 5 active keys per user (revoke one before
  creating another).
- **Cooldown**: at most 1 new key per hour, measured against the
  user's most recently created key.

Both rules are enforced server-side in `checkCreateKeyRateLimit`
(DB-based — no Redis client wired into the dashboard yet) and the
UI surfaces a precise error including "try again at <ISO time>" on
the cooldown case.

The plaintext is shown **exactly once**: the POST response carries
it, the `<CreateKeyForm />` displays it with a copy-to-clipboard
button + a sharply-worded "you cannot see this key again" warning,
and dismissing the warning clears it from React state. We only
ever stored the sha256 hash on disk.

Plaintext format: `sup_live_<32 alphanumeric>` (`sup` = Suverse
Pay namespace, chosen so the prefix does not collide with Stripe
/ GitHub / AWS / OpenAI / Anthropic key patterns and therefore
never trips upstream secret-scanning false positives; ~190 bits of
entropy from a 62-char alphabet). The `live` segment is reserved
for a future live/test split — for v1 only `live` is emitted.

Id format (the log-safe public identifier): `reskey_<8 hex>`,
matching the existing `apps/api` convention.

Revoke is **soft** — we never DELETE the row because
`facilitator_payments` FKs against it and CASCADE would drop the
audit trail. Settles already routed under a revoked key keep their
history; new requests using it 401 at the apps/api auth gate.

## First-time setup

### 1. DNS

Add a single A-record for the dashboard subdomain (run from a host
with credentials — Claude Code can't touch DNS panels):

```
suverse-pay.suverse.io  →  <your server IP>   TTL 300
```

### 2. OAuth app registrations

You need two OAuth apps — one each for Google and GitHub. Both
callbacks register the same `https://suverse-pay.suverse.io/api/auth/callback/{provider}`
URL.

**Google**:
1. https://console.cloud.google.com → APIs & Services → Credentials
2. Create OAuth client ID → Web application
3. Authorized redirect URIs (add BOTH):
   - `http://localhost:3002/api/auth/callback/google`
   - `https://suverse-pay.suverse.io/api/auth/callback/google`
4. Note the Client ID + Client Secret.

**GitHub**:
1. https://github.com/settings/developers → New OAuth App
2. Authorization callback URL: `https://suverse-pay.suverse.io/api/auth/callback/github`
   (GitHub allows only one callback per app — for local dev use a
   tunnel like `cloudflared` pointing at `localhost:3002`)
3. Note the Client ID + Client Secret.

### 3. Environment variables

Copy `.env.example` to `.env.local` for local dev or set in your
deployment platform:

```env
DATABASE_URL=postgres://suverse:suverse@localhost:5433/suverse_pay
NEXTAUTH_URL=https://suverse-pay.suverse.io   # http://localhost:3002 for dev
NEXTAUTH_SECRET=<openssl rand -base64 32>
GOOGLE_CLIENT_ID=<from step 2>
GOOGLE_CLIENT_SECRET=<from step 2>
GITHUB_CLIENT_ID=<from step 2>
GITHUB_CLIENT_SECRET=<from step 2>
```

### 4. Apply the migration

```bash
cd /path/to/suverse-pay
pnpm db:migrate
```

### 5. Run / deploy

Locally:
```bash
pnpm --filter @suverse-pay/dashboard dev
# → http://localhost:3002
```

Production (Vercel recommended):
- Connect the GitHub repo, set the build command to
  `pnpm --filter @suverse-pay/dashboard build`.
- Set environment variables in Vercel.
- Bind the custom domain `suverse-pay.suverse.io`.

## First-key flow for new customers

After signing in for the first time, the dashboard shows a "Get
started" card with two tabs:

- **Create new** (default) — type a label, hit "Create key", the
  generated plaintext appears with copy-to-clipboard. Save it; we
  cannot show it again.
- **Link existing** — paste a key that was issued out of band (ops
  bootstrapped it, a teammate sent it). Same form as before.

Both flows write into the `dashboard_user_resource_keys` link
table; from that point on, the dashboard panels populate with that
key's settles.

The bootstrap CLI (`pnpm db:bootstrap-resource-key`) is still
available for the ops case — but customers no longer need it.

## Tests

```bash
pnpm --filter @suverse-pay/dashboard test
# 29 tests across utils, queries, and the key-format invariants
```

The route handlers themselves are intentionally **not** unit-tested
yet — they're thin proxies to `queries.ts`. The queries module is
where the real logic lives and where future tests should accrete.

## Status

- Build: ✓ Next.js compiles
- Unit tests: ✓ 22/22 green
- Database migration: ✓ applies cleanly via `pnpm db:migrate`
- OAuth: requires registration (see step 2 above) before first sign-in
- Deployment: NOT yet deployed — operator runs steps 1–5 above
